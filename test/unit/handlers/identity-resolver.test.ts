/**
 * Unit tests for the Identity Resolver handler.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  IdentitystoreClient as IdentityStoreClient,
  ListUsersCommand,
  DescribeUserCommand,
} from '@aws-sdk/client-identitystore';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  resolveIamIdentity,
  resolveSsoIdentity,
  resolveIdentity,
  resetSingletons,
} from 'lib/handlers/identity-resolver/index';

const identityStoreMock = mockClient(IdentityStoreClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  identityStoreMock.reset();
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});
  resetSingletons();
  process.env['IDENTITY_MODE'] = 'iam';
  process.env['IDENTITY_STORE_ID'] = 'd-1234567890';
  process.env['IDENTITY_CACHE_TABLE'] = 'identity-cache-table';
  process.env['CIRCUIT_BREAKER_THRESHOLD'] = '5';
  process.env['CIRCUIT_BREAKER_COOLDOWN'] = '60000';
  process.env['RATE_LIMIT_MAX_RPS'] = '10000';
});

// ─── resolveIamIdentity ───────────────────────────────────────────────────────

describe('resolveIamIdentity', () => {
  it('extracts user name from IAM user ARN', () => {
    const result = resolveIamIdentity('arn:aws:iam::123456789012:user/alice');
    expect(result.principalType).toBe('user');
    expect(result.iamUserName).toBe('alice');
    expect(result.iamRoleName).toBeUndefined();
  });

  it('extracts role name from IAM role ARN', () => {
    const result = resolveIamIdentity('arn:aws:iam::123456789012:role/MyRole');
    expect(result.principalType).toBe('role');
    expect(result.iamRoleName).toBe('MyRole');
    expect(result.iamUserName).toBeUndefined();
  });

  it('extracts role name from assumed-role ARN', () => {
    const result = resolveIamIdentity('arn:aws:sts::123456789012:assumed-role/MyRole/session-name');
    expect(result.principalType).toBe('assumed-role');
    expect(result.iamRoleName).toBe('MyRole');
  });

  it('extracts user name from federated user ARN', () => {
    const result = resolveIamIdentity('arn:aws:sts::123456789012:federated-user/alice');
    expect(result.principalType).toBe('federated');
    expect(result.iamUserName).toBe('alice');
  });

  it('handles unknown ARN format gracefully', () => {
    const result = resolveIamIdentity('arn:aws:iam::123456789012:root');
    expect(result.principalType).toBe('unknown');
  });

  it('handles path-based user ARN', () => {
    const result = resolveIamIdentity('arn:aws:iam::123456789012:user/division/team/alice');
    expect(result.principalType).toBe('user');
    expect(result.iamUserName).toBe('division/team/alice');
  });
});

// ─── resolveSsoIdentity ───────────────────────────────────────────────────────

describe('resolveSsoIdentity', () => {
  it('returns SSO user when ListUsers finds a match', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({
      Users: [{
        IdentityStoreId: 'd-1234567890',
        UserId: 'user-abc-123',
        UserName: 'alice',
        DisplayName: 'Alice Smith',
        Emails: [{ Value: 'alice@example.com', Primary: true }],
      }],
    });

    const client = new IdentityStoreClient({});
    const result = await resolveSsoIdentity('alice', 'd-1234567890', client);

    expect(result).not.toBeNull();
    expect(result?.displayName).toBe('Alice Smith');
    expect(result?.email).toBe('alice@example.com');
    expect(result?.userId).toBe('user-abc-123');
  });

  it('returns null when no user found', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
    identityStoreMock.on(DescribeUserCommand).rejects(new Error('ResourceNotFoundException'));

    const client = new IdentityStoreClient({});
    const result = await resolveSsoIdentity('unknown-user', 'd-1234567890', client);

    expect(result).toBeNull();
  });

  it('uses first email when no primary email is set', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({
      Users: [{
        IdentityStoreId: 'd-1234567890',
        UserId: 'user-xyz',
        UserName: 'bob',
        DisplayName: 'Bob Jones',
        Emails: [{ Value: 'bob@example.com', Primary: false }],
      }],
    });

    const client = new IdentityStoreClient({});
    const result = await resolveSsoIdentity('bob', 'd-1234567890', client);

    expect(result?.email).toBe('bob@example.com');
  });

  it('falls back to GivenName+FamilyName when DisplayName is missing', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({
      Users: [{
        IdentityStoreId: 'd-1234567890',
        UserId: 'user-xyz',
        UserName: 'carol',
        Name: { GivenName: 'Carol', FamilyName: 'White' },
        Emails: [],
      }],
    });

    const client = new IdentityStoreClient({});
    const result = await resolveSsoIdentity('carol', 'd-1234567890', client);

    expect(result?.displayName).toBe('Carol White');
  });
});

// ─── resolveIdentity - SSO mode ───────────────────────────────────────────────

describe('resolveIdentity - SSO mode', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'sso';
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '100';
    resetSingletons();
  });

  it('returns SSO identity when match found', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({
      Users: [{
        IdentityStoreId: 'd-1234567890',
        UserId: 'user-abc',
        UserName: 'alice',
        DisplayName: 'Alice Smith',
        Emails: [{ Value: 'alice@example.com', Primary: true }],
      }],
    });

    const result = await resolveIdentity({
      principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/alice',
      sessionName: 'alice',
    });

    expect(result.resolved).toBe(true);
    expect(result.source).toBe('sso');
    expect(result.displayName).toBe('Alice Smith');
    expect(result.email).toBe('alice@example.com');
    expect(result.userId).toBe('user-abc');
  });

  it('returns unresolved when SSO returns no match', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
    identityStoreMock.on(DescribeUserCommand).rejects(new Error('ResourceNotFoundException'));

    const result = await resolveIdentity({
      principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/unknown',
    });

    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('sso_no_match');
  });
});

// ─── resolveIdentity - IAM mode ───────────────────────────────────────────────

describe('resolveIdentity - IAM mode', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'iam';
    resetSingletons();
  });

  it('resolves IAM user ARN', async () => {
    const result = await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:user/alice' });
    expect(result.resolved).toBe(true);
    expect(result.source).toBe('iam');
    expect(result.iamUserName).toBe('alice');
  });

  it('resolves IAM role ARN', async () => {
    const result = await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:role/MyRole' });
    expect(result.resolved).toBe(true);
    expect(result.source).toBe('iam');
    expect(result.iamRoleName).toBe('MyRole');
  });

  it('resolves assumed-role ARN', async () => {
    const result = await resolveIdentity({ principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session' });
    expect(result.resolved).toBe(true);
    expect(result.source).toBe('iam');
    expect(result.iamRoleName).toBe('MyRole');
  });

  it('does not call Identity Store API', async () => {
    await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:user/alice' });
    expect(identityStoreMock).not.toHaveReceivedCommand(ListUsersCommand);
    expect(identityStoreMock).not.toHaveReceivedCommand(DescribeUserCommand);
  });
});

// ─── resolveIdentity - Auto mode ─────────────────────────────────────────────

describe('resolveIdentity - Auto mode', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'auto';
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '100';
    resetSingletons();
  });

  it('returns SSO identity when SSO lookup succeeds', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({
      Users: [{
        IdentityStoreId: 'd-1234567890',
        UserId: 'user-abc',
        UserName: 'alice',
        DisplayName: 'Alice Smith',
        Emails: [{ Value: 'alice@example.com', Primary: true }],
      }],
    });

    const result = await resolveIdentity({
      principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/alice',
      sessionName: 'alice',
    });

    expect(result.resolved).toBe(true);
    expect(result.source).toBe('sso');
  });

  it('falls back to IAM when SSO returns no match', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
    identityStoreMock.on(DescribeUserCommand).rejects(new Error('ResourceNotFoundException'));

    const result = await resolveIdentity({
      principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session',
    });

    expect(result.resolved).toBe(true);
    expect(result.source).toBe('iam');
    expect(result.iamRoleName).toBe('MyRole');
  });
});

// ─── Cache hit / miss ─────────────────────────────────────────────────────────

describe('resolveIdentity - cache behavior', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'iam';
    resetSingletons();
  });

  it('returns cached identity on cache hit without API call', async () => {
    const cachedItem = {
      principalArn: 'arn:aws:iam::123456789012:user/alice',
      sourceType: 'resolved',
      resolved: true,
      displayName: 'Alice Smith',
      email: 'alice@example.com',
      userId: 'user-abc',
      source: 'sso',
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
    ddbMock.on(GetCommand).resolves({ Item: cachedItem });

    const result = await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:user/alice' });

    expect(result.source).toBe('cache');
    expect(result.displayName).toBe('Alice Smith');
    expect(identityStoreMock).not.toHaveReceivedCommand(ListUsersCommand);
  });

  it('calls API on cache miss and stores result', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:user/alice' });

    expect(ddbMock).toHaveReceivedCommand(PutCommand);
  });
});

// ─── Circuit breaker ─────────────────────────────────────────────────────────

describe('resolveIdentity - circuit breaker', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'sso';
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '5';
    process.env['CIRCUIT_BREAKER_COOLDOWN'] = '60000';
    resetSingletons();
  });

  it('opens circuit after 5 consecutive failures and returns placeholder', async () => {
    identityStoreMock.on(ListUsersCommand).rejects(new Error('ServiceUnavailable'));

    // Trigger 5 failures to open the circuit
    for (let i = 0; i < 5; i++) {
      try {
        await resolveIdentity({ principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session' });
      } catch {
        // Expected failures
      }
    }

    // 6th call should return placeholder (circuit open)
    const result = await resolveIdentity({ principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session' });

    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('circuit_breaker_open');
    expect(result.source).toBe('placeholder');
  });
});

// ─── Rate limiter ─────────────────────────────────────────────────────────────

describe('resolveIdentity - rate limiter', () => {
  it('processes requests within rate limit without blocking', async () => {
    process.env['IDENTITY_MODE'] = 'iam';
    process.env['RATE_LIMIT_MAX_RPS'] = '10000';
    resetSingletons();

    const start = Date.now();
    const promises = Array.from({ length: 10 }, (_, i) =>
      resolveIdentity({ principalArn: `arn:aws:iam::123456789012:user/user${i}` }),
    );
    await Promise.all(promises);
    const elapsed = Date.now() - start;

    // With 10000 RPS, 10 requests should complete in well under 1 second
    expect(elapsed).toBeLessThan(2000);
  });
});

// ─── Session tracking ─────────────────────────────────────────────────────────

describe('resolveIdentity - session tracking', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'iam';
    resetSingletons();
  });

  it('maps same accessKeyId to same identity across multiple invocations', async () => {
    const principalArn = 'arn:aws:sts::123456789012:assumed-role/MyRole/alice';
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';

    const result1 = await resolveIdentity({ principalArn, accessKeyId });
    const result2 = await resolveIdentity({ principalArn, accessKeyId });
    const result3 = await resolveIdentity({ principalArn, accessKeyId });

    expect(result1.iamRoleName).toBe(result2.iamRoleName);
    expect(result2.iamRoleName).toBe(result3.iamRoleName);
  });
});

// ─── Guardrail attribution ────────────────────────────────────────────────────

describe('resolveIdentity - guardrail attribution', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'iam';
    resetSingletons();
  });

  it('attributes guardrail usage to same identity as parent invocation', async () => {
    const principalArn = 'arn:aws:sts::123456789012:assumed-role/MyRole/alice';
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';

    // Parent invocation
    const parentResult = await resolveIdentity({ principalArn, accessKeyId });

    // Guardrail invocation with same accessKeyId
    const guardrailResult = await resolveIdentity({
      principalArn,
      accessKeyId,
      guardrailId: 'guardrail-abc-123',
    });

    expect(guardrailResult.iamRoleName).toBe(parentResult.iamRoleName);
  });
});

// ─── Correlation window ───────────────────────────────────────────────────────

describe('resolveIdentity - requestId correlation', () => {
  it('accepts requestId and timestamp in resolution request', async () => {
    process.env['IDENTITY_MODE'] = 'iam';
    resetSingletons();

    const result = await resolveIdentity({
      principalArn: 'arn:aws:iam::123456789012:user/alice',
      requestId: 'req-12345',
      timestamp: new Date().toISOString(),
    });

    expect(result.resolved).toBe(true);
  });
});

// ─── resolveSsoIdentity - DescribeUser path ───────────────────────────────────

describe('resolveSsoIdentity - DescribeUser path', () => {
  it('resolves via DescribeUser when ListUsers returns empty but DescribeUser succeeds', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
    identityStoreMock.on(DescribeUserCommand).resolves({
      IdentityStoreId: 'd-1234567890',
      UserId: 'user-direct-123',
      UserName: 'direct-user',
      DisplayName: 'Direct User',
      Emails: [{ Value: 'direct@example.com', Primary: true }],
    });

    const client = new IdentityStoreClient({});
    const result = await resolveSsoIdentity('user-direct-123', 'd-1234567890', client);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe('user-direct-123');
    expect(result?.displayName).toBe('Direct User');
    expect(result?.email).toBe('direct@example.com');
  });

  it('falls back to GivenName+FamilyName in DescribeUser when DisplayName is missing', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
    identityStoreMock.on(DescribeUserCommand).resolves({
      IdentityStoreId: 'd-1234567890',
      UserId: 'user-xyz',
      UserName: 'bob',
      Name: { GivenName: 'Bob', FamilyName: 'Jones' },
      Emails: [],
    });

    const client = new IdentityStoreClient({});
    const result = await resolveSsoIdentity('user-xyz', 'd-1234567890', client);

    expect(result?.displayName).toBe('Bob Jones');
  });

  it('falls back to UserName in DescribeUser when DisplayName and Name are missing', async () => {
    identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
    identityStoreMock.on(DescribeUserCommand).resolves({
      IdentityStoreId: 'd-1234567890',
      UserId: 'user-xyz',
      UserName: 'carol',
      Emails: [],
    });

    const client = new IdentityStoreClient({});
    const result = await resolveSsoIdentity('user-xyz', 'd-1234567890', client);

    expect(result?.displayName).toBe('carol');
  });
});

// ─── Cache behavior when IDENTITY_CACHE_TABLE is not set ─────────────────────

describe('resolveIdentity - no cache table configured', () => {
  it('resolves without cache when IDENTITY_CACHE_TABLE is not set', async () => {
    process.env['IDENTITY_MODE'] = 'iam';
    delete process.env['IDENTITY_CACHE_TABLE'];
    resetSingletons();

    const result = await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:user/alice' });

    expect(result.resolved).toBe(true);
    expect(result.source).toBe('iam');
    // DynamoDB should not have been called
    expect(ddbMock).not.toHaveReceivedCommand(GetCommand);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });
});

// ─── Cache error handling ─────────────────────────────────────────────────────

describe('resolveIdentity - cache error handling', () => {
  it('continues resolution when cache get fails', async () => {
    process.env['IDENTITY_MODE'] = 'iam';
    process.env['IDENTITY_CACHE_TABLE'] = 'identity-cache-table';
    resetSingletons();

    ddbMock.on(GetCommand).rejects(new Error('DynamoDB unavailable'));
    ddbMock.on(PutCommand).resolves({});

    const result = await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:user/alice' });

    expect(result.resolved).toBe(true);
    expect(result.source).toBe('iam');
  });

  it('continues when cache put fails', async () => {
    process.env['IDENTITY_MODE'] = 'iam';
    process.env['IDENTITY_CACHE_TABLE'] = 'identity-cache-table';
    resetSingletons();

    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB write failed'));

    const result = await resolveIdentity({ principalArn: 'arn:aws:iam::123456789012:user/alice' });

    expect(result.resolved).toBe(true);
    expect(result.source).toBe('iam');
  });
});

// ─── Auto mode - circuit breaker open ────────────────────────────────────────

describe('resolveIdentity - auto mode circuit breaker', () => {
  beforeEach(() => {
    process.env['IDENTITY_MODE'] = 'auto';
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '5';
    process.env['CIRCUIT_BREAKER_COOLDOWN'] = '60000';
    resetSingletons();
  });

  it('returns placeholder in auto mode when circuit breaker is open', async () => {
    identityStoreMock.on(ListUsersCommand).rejects(new Error('ServiceUnavailable'));

    // Trigger 5 failures to open the circuit
    for (let i = 0; i < 5; i++) {
      try {
        await resolveIdentity({ principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session' });
      } catch {
        // Expected
      }
    }

    // Next call in auto mode should return placeholder (not fall back to IAM)
    const result = await resolveIdentity({ principalArn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session' });

    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('circuit_breaker_open');
  });
});

// ─── Session cache with guardrail ─────────────────────────────────────────────

describe('resolveIdentity - session cache with guardrail', () => {
  it('returns cached identity with source=cache for guardrail invocation', async () => {
    process.env['IDENTITY_MODE'] = 'iam';
    resetSingletons();

    const principalArn = 'arn:aws:sts::123456789012:assumed-role/MyRole/alice';
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';

    // First call populates session cache
    await resolveIdentity({ principalArn, accessKeyId });

    // Second call with guardrailId should use session cache
    const guardrailResult = await resolveIdentity({
      principalArn,
      accessKeyId,
      guardrailId: 'guardrail-xyz',
    });

    expect(guardrailResult.source).toBe('cache');
  });
});
