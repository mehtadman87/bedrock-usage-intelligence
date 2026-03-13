/**
 * S3 Partitioner Utility
 *
 * Generates Hive-style S3 partition paths for Athena partition projection.
 * Supports both single-region and multi-region partitioning schemes.
 *
 * Single-region:  {prefix}/year={YYYY}/month={MM}/day={DD}/hour={HH}/
 * Multi-region:   {prefix}/region={region}/year={YYYY}/month={MM}/day={DD}/hour={HH}/
 */

/**
 * Generates a Hive-style S3 partition path from a prefix and timestamp.
 *
 * @param prefix    - The S3 key prefix (e.g. "invocation-logs"). No trailing slash required.
 * @param timestamp - The Date used to derive year, month, day, and hour components.
 * @param region    - Optional AWS region string. When provided, a `region=` partition is
 *                    prepended before the date/time partitions (multi-region mode).
 * @returns A partition path string ending with a trailing slash, e.g.
 *          `"invocation-logs/year=2024/month=01/day=05/hour=09/"` (single-region) or
 *          `"invocation-logs/region=us-east-1/year=2024/month=01/day=05/hour=09/"` (multi-region).
 */
export function generatePartitionPath(
  prefix: string,
  timestamp: Date,
  region?: string,
): string {
  const year = timestamp.getUTCFullYear().toString();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getUTCDate()).padStart(2, '0');
  const hour = String(timestamp.getUTCHours()).padStart(2, '0');

  const datePart = `year=${year}/month=${month}/day=${day}/hour=${hour}/`;

  if (region !== undefined) {
    return `${prefix}/region=${region}/${datePart}`;
  }

  return `${prefix}/${datePart}`;
}
