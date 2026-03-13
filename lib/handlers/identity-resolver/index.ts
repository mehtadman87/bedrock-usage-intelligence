import {
  IdentitystoreClient as IdentityStoreClient,
  DescribeUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-identitystore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CircuitBreaker } from 'lib/shared/circuit-breaker';
import { TokenBucketRateLimiter } from 'lib/shared/rate-limiter';
import { IDENTITY_CACHE_TTL_SECONDS } from 'lib/shared/constants';

// ─── Environment helpers ──────────────────────────────────────────────────────

function getEnv(name: string, defaultValue = ''): string {
  return process.env[name] ?? defaultValue;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdentityResolutionRequest {
  principalArn: string;
  sessionName?: string;
  accessKeyId?: string;
  requestId?: string;
  timestamp?: string;
  guardrailId?: string;
}

export interface ResolvedIdentity {
  resolved: boolean;
  reason?: string;
  displayName?: string;
  email?: string;
  userId?: string;
  iamUserName?: string;
  iamRoleName?: string;
  source: 'sso' | 'iam' | 'cache' | 'placeholder';
}

export interface IamIdentity {
  iamUserName?: string;
  iamRoleName?: string;
  principalType: 'user' | 'role' | 'assumed-role' | 'federated' | 'unknown';
}

export interface SsoIdentity {
  displayName: string;
  email: string;
  userId: string;
}

// ─── Lazy singletons ──────────────────────────────────────────────────────────

let _identityStoreClient: IdentityStoreClient | null = null;
let _ddbDocClient: DynamoDBDocumentClient | null = null;
let _circuitBreaker: CircuitBreaker | null = null;
let _rateLimiter: TokenBucketRateLimiter | null = null;

// In-memory session tracking: accessKeyId → ResolvedIdentity
const sessionCache = new Map<string, ResolvedIdentity>();

/**
 * Reset all module-level singletons. Intended for use in tests only.
 */
export function resetSingletons(): void {
  _identityStoreClient = null;
  _ddbDocClient = null;
  _circuitBreaker = null;
  _rateLimiter = null;
  sessionCache.clear();
}

function getIdentityStoreClient(): IdentityStoreClient {
  if (!_identityStoreClient) {
    _identityStoreClient = new IdentityStoreClient({});
  }
  return _identityStoreClient;
}

function getDdbDocClient(): DynamoDBDocumentClient {
  if (!_ddbDocClient) {
    _ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _ddbDocClient;
}

function getCircuitBreaker(): CircuitBreaker {
  if (!_circuitBreaker) {
    const threshold = parseInt(getEnv('CIRCUIT_BREAKER_THRESHOLD', '5'), 10);
    const cooldown = parseInt(getEnv('CIRCUIT_BREAKER_COOLDOWN', '60000'), 10);
    _circuitBreaker = new CircuitBreaker(threshold, cooldown);
  }
  return _circuitBreaker;
}

function getRateLimiter(): TokenBucketRateLimiter {
  if (!_rateLimiter) {
    const maxRps = parseInt(getEnv('RATE_LIMIT_MAX_RPS', '10'), 10);
    _rateLimiter = new TokenBucketRateLimiter(maxRps, maxRps);
  }
  return _rateLimiter;
}

// ─── IAM Identity Resolution ──────────────────────────────────────────────────

/**
 * Extracts user/role name from an IAM principal ARN without external API calls.
 *
 * Supported ARN formats:
 *   arn:aws:iam::123456789012:user/alice
 *   arn:aws:iam::123456789012:role/MyRole
 *   arn:aws:sts::123456789012:assumed-role/MyRole/session-name
 *   arn:aws:sts::123456789012:federated-user/alice
 *
 * Requirements: 8.2
 */
export function resolveIamIdentity(principalArn: string): IamIdentity {
  // IAM user: arn:aws:iam::ACCOUNT:user/NAME
  const userMatch = principalArn.match(/^arn:aws[^:]*:iam::[^:]*:user\/(.+)$/);
  if (userMatch) {
    return { iamUserName: userMatch[1], principalType: 'user' };
  }

  // IAM role: arn:aws:iam::ACCOUNT:role/NAME
  const roleMatch = principalArn.match(/^arn:aws[^:]*:iam::[^:]*:role\/(.+)$/);
  if (roleMatch) {
    return { iamRoleName: roleMatch[1], principalType: 'role' };
  }

  // Assumed role: arn:aws:sts::ACCOUNT:assumed-role/ROLE/SESSION
  const assumedRoleMatch = principalArn.match(
    /^arn:aws[^:]*:sts::[^:]*:assumed-role\/([^/]+)\/(.+)$/,
  );
  if (assumedRoleMatch) {
    return { iamRoleName: assumedRoleMatch[1], principalType: 'assumed-role' };
  }

  // Federated user: arn:aws:sts::ACCOUNT:federated-user/NAME
  const federatedMatch = principalArn.match(/^arn:aws[^:]*:sts::[^:]*:federated-user\/(.+)$/);
  if (federatedMatch) {
    return { iamUserName: federatedMatch[1], principalType: 'federated' };
  }

  return { principalType: 'unknown' };
}

// ─── SSO Identity Resolution ──────────────────────────────────────────────────

/**
 * Queries IAM Identity Center to resolve a role session name to an SSO user.
 *
 * Uses ListUsers with a filter on the UserName attribute matching the session name.
 * Returns null when no matching user is found.
 *
 * Requirements: 8.1
 */
export async function resolveSsoIdentity(
  sessionName: string,
  identityStoreId: string,
  client: IdentityStoreClient,
): Promise<SsoIdentity | null> {
  // First try ListUsers with a filter on UserName
  const listResponse = await client.send(
    new ListUsersCommand({
      IdentityStoreId: identityStoreId,
      Filters: [{ AttributePath: 'UserName', AttributeValue: sessionName }],
    }),
  );

  if (listResponse.Users && listResponse.Users.length > 0) {
    const user = listResponse.Users[0]!;
    const displayName =
      user.DisplayName ??
      [user.Name?.GivenName, user.Name?.FamilyName].filter(Boolean).join(' ') ??
      user.UserName ??
      sessionName;
    const email =
      user.Emails?.find((e: { Primary?: boolean }) => e.Primary)?.Value ??
      user.Emails?.[0]?.Value ??
      '';
    return {
      displayName,
      email,
      userId: user.UserId ?? '',
    };
  }

  // Try DescribeUser by userId if sessionName looks like a userId
  try {
    const describeResponse = await client.send(
      new DescribeUserCommand({
        IdentityStoreId: identityStoreId,
        UserId: sessionName,
      }),
    );
    if (describeResponse.UserId) {
      const displayName =
        describeResponse.DisplayName ??
        ([describeResponse.Name?.GivenName, describeResponse.Name?.FamilyName]
          .filter(Boolean)
          .join(' ') || undefined) ??
        describeResponse.UserName ??
        sessionName;
      const email =
        describeResponse.Emails?.find((e: { Primary?: boolean }) => e.Primary)?.Value ??
        describeResponse.Emails?.[0]?.Value ??
        '';
      return {
        displayName,
        email,
        userId: describeResponse.UserId,
      };
    }
  } catch {
    // DescribeUser failed (e.g., not a valid userId) — fall through to return null
  }

  return null;
}

// ─── DynamoDB Cache ───────────────────────────────────────────────────────────

async function getCachedIdentity(
  principalArn: string,
  ddb: DynamoDBDocumentClient,
): Promise<ResolvedIdentity | null> {
  const tableName = getEnv('IDENTITY_CACHE_TABLE');
  if (!tableName) return null;

  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { principalArn, sourceType: 'resolved' },
      }),
    );

    if (result.Item) {
      return result.Item as ResolvedIdentity;
    }
  } catch (err) {
    console.warn('Identity cache get failed:', err);
  }

  return null;
}

async function cacheIdentity(
  principalArn: string,
  identity: ResolvedIdentity,
  ddb: DynamoDBDocumentClient,
): Promise<void> {
  const tableName = getEnv('IDENTITY_CACHE_TABLE');
  if (!tableName) return;

  const expiresAt = Math.floor(Date.now() / 1000) + IDENTITY_CACHE_TTL_SECONDS;

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          principalArn,
          sourceType: 'resolved',
          ...identity,
          expiresAt,
          resolvedAt: new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    console.warn('Identity cache put failed:', err);
  }
}

// ─── Main Resolution Function ─────────────────────────────────────────────────

/**
 * Resolves an IAM principal to a human identity.
 *
 * Resolution order:
 * 1. Check in-memory session cache (accessKeyId → identity)
 * 2. Check DynamoDB Identity_Cache
 * 3. Resolve via SSO / IAM / auto based on IDENTITY_MODE env var
 * 4. Cache result and update session tracking
 *
 * When circuit breaker is open, returns a placeholder identity.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 13.5, 13.6, 18.2, 18.3
 */
export async function resolveIdentity(
  request: IdentityResolutionRequest,
): Promise<ResolvedIdentity> {
  const { principalArn, sessionName, accessKeyId, guardrailId } = request;
  const identityMode = getEnv('IDENTITY_MODE', 'iam');
  const identityStoreId = getEnv('IDENTITY_STORE_ID', '');
  const ddb = getDdbDocClient();

  // ── 1. Session cache (accessKeyId → identity) ─────────────────────────────
  if (accessKeyId && sessionCache.has(accessKeyId)) {
    const cached = sessionCache.get(accessKeyId)!;
    // If this is a guardrail invocation, attribute to the same identity
    if (guardrailId) {
      return { ...cached, source: 'cache' };
    }
    return cached;
  }

  // ── 2. DynamoDB cache ─────────────────────────────────────────────────────
  const cachedIdentity = await getCachedIdentity(principalArn, ddb);
  if (cachedIdentity) {
    const result: ResolvedIdentity = { ...cachedIdentity, source: 'cache' };
    if (accessKeyId) {
      sessionCache.set(accessKeyId, result);
    }
    return result;
  }

  // ── 3. Resolve via configured mode ────────────────────────────────────────
  let resolved: ResolvedIdentity;

  if (identityMode === 'iam') {
    resolved = resolveViaIam(principalArn);
  } else if (identityMode === 'sso') {
    resolved = await resolveViaSso(principalArn, sessionName, identityStoreId);
  } else {
    // auto: try SSO first, fall back to IAM
    resolved = await resolveViaAuto(principalArn, sessionName, identityStoreId);
  }

  // ── 4. Cache and track session ────────────────────────────────────────────
  if (resolved.resolved) {
    await cacheIdentity(principalArn, resolved, ddb);
    if (accessKeyId) {
      sessionCache.set(accessKeyId, resolved);
    }
  }

  return resolved;
}

// ─── Resolution mode helpers ──────────────────────────────────────────────────

function resolveViaIam(principalArn: string): ResolvedIdentity {
  const iamIdentity = resolveIamIdentity(principalArn);
  return {
    resolved: true,
    iamUserName: iamIdentity.iamUserName,
    iamRoleName: iamIdentity.iamRoleName,
    source: 'iam',
  };
}

async function resolveViaSso(
  principalArn: string,
  sessionName: string | undefined,
  identityStoreId: string,
): Promise<ResolvedIdentity> {
  const cb = getCircuitBreaker();
  const rl = getRateLimiter();

  // Circuit breaker open → return placeholder
  if (cb.getState() === 'open') {
    console.warn('Circuit breaker is open, returning placeholder identity');
    return {
      resolved: false,
      reason: 'circuit_breaker_open',
      source: 'placeholder',
    };
  }

  // Rate limiting
  await rl.acquire();

  // Extract session name from ARN if not provided
  const nameToLookup = sessionName ?? extractSessionName(principalArn);

  try {
    const ssoIdentity = await cb.execute(() =>
      resolveSsoIdentity(
        nameToLookup,
        identityStoreId,
        getIdentityStoreClient(),
      ),
    );

    if (ssoIdentity) {
      return {
        resolved: true,
        displayName: ssoIdentity.displayName,
        email: ssoIdentity.email,
        userId: ssoIdentity.userId,
        source: 'sso',
      };
    }

    // SSO returned no match
    return {
      resolved: false,
      reason: 'sso_no_match',
      source: 'placeholder',
    };
  } catch (err) {
    if ((err as Error).message === 'Circuit breaker is open') {
      return {
        resolved: false,
        reason: 'circuit_breaker_open',
        source: 'placeholder',
      };
    }
    throw err;
  }
}

async function resolveViaAuto(
  principalArn: string,
  sessionName: string | undefined,
  identityStoreId: string,
): Promise<ResolvedIdentity> {
  // Try SSO first
  const ssoResult = await resolveViaSso(principalArn, sessionName, identityStoreId);

  if (ssoResult.resolved) {
    return ssoResult;
  }

  // Circuit breaker open — return placeholder (don't fall back to IAM)
  if (ssoResult.reason === 'circuit_breaker_open') {
    return ssoResult;
  }

  // SSO returned no match — fall back to IAM
  return resolveViaIam(principalArn);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Extracts the session name from an assumed-role ARN.
 * For other ARN types, returns the last path segment.
 */
function extractSessionName(principalArn: string): string {
  // assumed-role: arn:aws:sts::ACCOUNT:assumed-role/ROLE/SESSION
  const assumedRoleMatch = principalArn.match(
    /^arn:aws[^:]*:sts::[^:]*:assumed-role\/[^/]+\/(.+)$/,
  );
  if (assumedRoleMatch) {
    return assumedRoleMatch[1]!;
  }

  // user: arn:aws:iam::ACCOUNT:user/NAME
  const userMatch = principalArn.match(/\/([^/]+)$/);
  if (userMatch) {
    return userMatch[1]!;
  }

  return principalArn;
}

// ─── Lambda Handler ───────────────────────────────────────────────────────────

/**
 * Lambda handler entry point.
 * Accepts an IdentityResolutionRequest and returns a ResolvedIdentity.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 13.5, 13.6, 18.2, 18.3
 */
export const handler = async (
  event: IdentityResolutionRequest,
): Promise<ResolvedIdentity> => {
  return resolveIdentity(event);
};

// handler is already exported as a named export above
