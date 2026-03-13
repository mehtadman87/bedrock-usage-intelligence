// Feature: bedrock-usage-intelligence, Property 12-17: Identity Resolution
import * as fc from 'fast-check';
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
  IdentityResolutionRequest,
} from 'lib/handlers/identity-resolver/index';


// ─── Mocks ────────────────────────────────────────────────────────────────────

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

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const accountIdArb = fc.stringMatching(/^\d{12}$/);

const nameArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/);

const iamUserArnArb = fc
  .tuple(accountIdArb, nameArb)
  .map(([account, name]) => `arn:aws:iam::${account}:user/${name}`);

const iamRoleArnArb = fc
  .tuple(accountIdArb, nameArb)
  .map(([account, name]) => `arn:aws:iam::${account}:role/${name}`);

const assumedRoleArnArb = fc
  .tuple(accountIdArb, nameArb, nameArb)
  .map(([account, role, session]) => `arn:aws:sts::${account}:assumed-role/${role}/${session}`);

const iamPrincipalArnArb = fc.oneof(iamUserArnArb, iamRoleArnArb, assumedRoleArnArb);

const displayNameArb = fc.stringMatching(/^[a-zA-Z0-9 ]{1,50}$/);

const emailArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{1,10}$/),
    fc.stringMatching(/^[a-z0-9]{1,10}$/),
  )
  .map(([local, domain]) => `${local}@${domain}.com`);

const userIdArb = fc.stringMatching(/^[a-zA-Z0-9-]{1,36}$/);


// ─── Property 12: SSO identity resolution ────────────────────────────────────

describe('Property 12: SSO identity resolution', () => {
  // Validates: Requirements 8.1

  it('returns displayName, email, and userId for matching SSO user', async () => {
    await fc.assert(
      fc.asyncProperty(
        nameArb,
        displayNameArb,
        emailArb,
        userIdArb,
        async (sessionName, displayName, email, userId) => {
          identityStoreMock.on(ListUsersCommand).resolves({
            Users: [
              {
                IdentityStoreId: 'd-1234567890',
                UserId: userId,
                UserName: sessionName,
                DisplayName: displayName,
                Emails: [{ Value: email, Primary: true }],
              },
            ],
          });

          const client = new IdentityStoreClient({});
          const result = await resolveSsoIdentity(sessionName, 'd-1234567890', client);

          return (
            result !== null &&
            result.displayName === displayName &&
            result.email === email &&
            result.userId === userId
          );
        },
      ),
      { numRuns: 25 },
    );
  });

  it('returns null when no matching SSO user is found', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, async (sessionName) => {
        identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
        identityStoreMock.on(DescribeUserCommand).rejects(new Error('ResourceNotFoundException'));

        const client = new IdentityStoreClient({});
        const result = await resolveSsoIdentity(sessionName, 'd-1234567890', client);

        return result === null;
      }),
      { numRuns: 25 },
    );
  });
});


// ─── Property 13: IAM identity resolution ────────────────────────────────────

describe('Property 13: IAM identity resolution', () => {
  // Validates: Requirements 8.2

  it('extracts IAM user name from user ARN without external API calls', () => {
    fc.assert(
      fc.property(iamUserArnArb, (arn) => {
        const result = resolveIamIdentity(arn);
        return (
          result.principalType === 'user' &&
          typeof result.iamUserName === 'string' &&
          result.iamUserName.length > 0
        );
      }),
      { numRuns: 25 },
    );
  });

  it('extracts IAM role name from role ARN without external API calls', () => {
    fc.assert(
      fc.property(iamRoleArnArb, (arn) => {
        const result = resolveIamIdentity(arn);
        return (
          result.principalType === 'role' &&
          typeof result.iamRoleName === 'string' &&
          result.iamRoleName.length > 0
        );
      }),
      { numRuns: 25 },
    );
  });

  it('extracts role name from assumed-role ARN without external API calls', () => {
    fc.assert(
      fc.property(assumedRoleArnArb, (arn) => {
        const result = resolveIamIdentity(arn);
        return (
          result.principalType === 'assumed-role' &&
          typeof result.iamRoleName === 'string' &&
          result.iamRoleName.length > 0
        );
      }),
      { numRuns: 25 },
    );
  });

  it('resolveIdentity in iam mode never calls Identity Store API', async () => {
    await fc.assert(
      fc.asyncProperty(iamPrincipalArnArb, async (principalArn) => {
        resetSingletons();
        process.env['IDENTITY_MODE'] = 'iam';
        identityStoreMock.reset();
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(PutCommand).resolves({});

        const request: IdentityResolutionRequest = { principalArn };
        const result = await resolveIdentity(request);

        const listCalls = identityStoreMock.commandCalls(ListUsersCommand);
        const describeCalls = identityStoreMock.commandCalls(DescribeUserCommand);

        return (
          result.resolved === true &&
          result.source === 'iam' &&
          listCalls.length === 0 &&
          describeCalls.length === 0
        );
      }),
      { numRuns: 25 },
    );
  });
});


// ─── Property 14: Auto-mode identity fallback ─────────────────────────────────

describe('Property 14: Auto-mode identity fallback', () => {
  // Validates: Requirements 8.3

  it('falls back to IAM when SSO lookup returns no match', async () => {
    await fc.assert(
      fc.asyncProperty(iamPrincipalArnArb, async (principalArn) => {
        resetSingletons();
        process.env['IDENTITY_MODE'] = 'auto';
        process.env['CIRCUIT_BREAKER_THRESHOLD'] = '1000';
        process.env['RATE_LIMIT_MAX_RPS'] = '10000';

        identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });
        identityStoreMock.on(DescribeUserCommand).rejects(new Error('ResourceNotFoundException'));
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        ddbMock.on(PutCommand).resolves({});

        const request: IdentityResolutionRequest = { principalArn };
        const result = await resolveIdentity(request);

        return result.resolved === true && result.source === 'iam';
      }),
      { numRuns: 25 },
    );
  });

  it('returns SSO identity when SSO lookup succeeds in auto mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        assumedRoleArnArb,
        displayNameArb,
        emailArb,
        userIdArb,
        async (principalArn, displayName, email, userId) => {
          resetSingletons();
          process.env['IDENTITY_MODE'] = 'auto';
          process.env['CIRCUIT_BREAKER_THRESHOLD'] = '1000';
          process.env['RATE_LIMIT_MAX_RPS'] = '10000';

          const sessionMatch = principalArn.match(/assumed-role\/[^/]+\/(.+)$/);
          const sessionName = sessionMatch ? sessionMatch[1]! : 'session';

          identityStoreMock.on(ListUsersCommand).resolves({
            Users: [
              {
                IdentityStoreId: 'd-1234567890',
                UserId: userId,
                UserName: sessionName,
                DisplayName: displayName,
                Emails: [{ Value: email, Primary: true }],
              },
            ],
          });
          ddbMock.on(GetCommand).resolves({ Item: undefined });
          ddbMock.on(PutCommand).resolves({});

          const request: IdentityResolutionRequest = { principalArn, sessionName };
          const result = await resolveIdentity(request);

          return result.resolved === true && result.source === 'sso';
        },
      ),
      { numRuns: 25 },
    );
  });
});


// ─── Property 15: Identity cache round trip ───────────────────────────────────

describe('Property 15: Identity cache round trip', () => {
  // Validates: Requirements 8.4

  it('second resolution returns cached identity without calling Identity Store', async () => {
    await fc.assert(
      fc.asyncProperty(
        iamPrincipalArnArb,
        displayNameArb,
        emailArb,
        userIdArb,
        async (principalArn, displayName, email, userId) => {
          resetSingletons();
          process.env['IDENTITY_MODE'] = 'sso';
          process.env['CIRCUIT_BREAKER_THRESHOLD'] = '1000';
          process.env['RATE_LIMIT_MAX_RPS'] = '10000';

          const cachedItem = {
            principalArn,
            sourceType: 'resolved',
            resolved: true,
            displayName,
            email,
            userId,
            source: 'sso' as const,
            expiresAt: Math.floor(Date.now() / 1000) + 86400,
          };

          ddbMock
            .on(GetCommand)
            .resolvesOnce({ Item: undefined })
            .resolves({ Item: cachedItem });
          ddbMock.on(PutCommand).resolves({});

          identityStoreMock.on(ListUsersCommand).resolves({
            Users: [
              {
                IdentityStoreId: 'd-1234567890',
                UserId: userId,
                UserName: 'session',
                DisplayName: displayName,
                Emails: [{ Value: email, Primary: true }],
              },
            ],
          });

          const request: IdentityResolutionRequest = { principalArn };

          // First resolution (cache miss)
          await resolveIdentity(request);

          // Reset Identity Store mock to detect if it's called again
          identityStoreMock.reset();
          identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });

          // Second resolution — should hit DynamoDB cache
          const secondResult = await resolveIdentity(request);

          const listCalls = identityStoreMock.commandCalls(ListUsersCommand);

          return (
            secondResult.resolved === true &&
            secondResult.source === 'cache' &&
            secondResult.displayName === displayName &&
            secondResult.email === email &&
            secondResult.userId === userId &&
            listCalls.length === 0
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});


// ─── Property 16: Session tracking consistency ────────────────────────────────

describe('Property 16: Session tracking consistency', () => {
  // Validates: Requirements 8.6

  it('all invocations with same accessKeyId are attributed to same identity', async () => {
    await fc.assert(
      fc.asyncProperty(
        iamPrincipalArnArb,
        fc.stringMatching(/^[A-Z0-9]{16,20}$/),
        fc.integer({ min: 2, max: 5 }),
        async (principalArn, accessKeyId, invocationCount) => {
          resetSingletons();
          process.env['IDENTITY_MODE'] = 'iam';
          ddbMock.on(GetCommand).resolves({ Item: undefined });
          ddbMock.on(PutCommand).resolves({});

          const results: Array<{ iamUserName?: string; iamRoleName?: string }> = [];

          for (let i = 0; i < invocationCount; i++) {
            const request: IdentityResolutionRequest = { principalArn, accessKeyId };
            const result = await resolveIdentity(request);
            results.push({ iamUserName: result.iamUserName, iamRoleName: result.iamRoleName });
          }

          const first = results[0]!;
          return results.every(
            (r) => r.iamUserName === first.iamUserName && r.iamRoleName === first.iamRoleName,
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ─── Property 17: Guardrail identity attribution ──────────────────────────────

describe('Property 17: Guardrail identity attribution', () => {
  // Validates: Requirements 8.7

  it('guardrail usage is attributed to same resolved user identity as parent invocation', async () => {
    await fc.assert(
      fc.asyncProperty(
        iamPrincipalArnArb,
        fc.stringMatching(/^[A-Z0-9]{16,20}$/),
        fc.stringMatching(/^[a-zA-Z0-9-]{1,36}$/),
        async (principalArn, accessKeyId, guardrailId) => {
          resetSingletons();
          process.env['IDENTITY_MODE'] = 'iam';
          ddbMock.on(GetCommand).resolves({ Item: undefined });
          ddbMock.on(PutCommand).resolves({});

          const parentRequest: IdentityResolutionRequest = { principalArn, accessKeyId };
          const parentResult = await resolveIdentity(parentRequest);

          const guardrailRequest: IdentityResolutionRequest = {
            principalArn,
            accessKeyId,
            guardrailId,
          };
          const guardrailResult = await resolveIdentity(guardrailRequest);

          return (
            guardrailResult.iamUserName === parentResult.iamUserName &&
            guardrailResult.iamRoleName === parentResult.iamRoleName
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});
