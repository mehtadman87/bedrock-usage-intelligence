import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as quicksight from 'aws-cdk-lib/aws-quicksight';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';

export interface AnalyticsStackProps extends cdk.StackProps {
  config: PlatformConfig;
  cmk: kms.Key;
  processedDataBucket: s3.Bucket;
}

export class AnalyticsStack extends cdk.Stack {
  public readonly glueDatabase: glue.CfnDatabase;
  public readonly athenaWorkgroup: athena.CfnWorkGroup;
  public readonly dataSetId: string | undefined;
  public readonly metricsDataSetId: string | undefined;
  public readonly dataSourceArn: string | undefined;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    const { config, cmk, processedDataBucket } = props;
    const { solutionName } = config.deployment;
    const isMultiRegion = config.region.regionMode === 'multi';
    const sourceRegions =
      isMultiRegion && config.region.regionMode === 'multi'
        ? config.region.sourceRegions
        : [this.region];

    // ── Glue Database ─────────────────────────────────────────────────────────
    this.glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: `${solutionName}_analytics`,
        description: `Bedrock Usage Intelligence Platform analytics database for ${solutionName}`,
        parameters: {
          // Encrypt Glue Data Catalog with CMK
          'glue.catalog.encryption.mode': 'SSE-KMS',
          'glue.catalog.encryption.kms-key': cmk.keyArn,
        },
      },
    });

    // ── Glue Tables ───────────────────────────────────────────────────────────
    this.createInvocationLogsTable(solutionName, processedDataBucket, isMultiRegion, sourceRegions);
    this.createCloudTrailEventsTable(solutionName, processedDataBucket, isMultiRegion, sourceRegions);
    this.createMetricsTable(solutionName, processedDataBucket, isMultiRegion, sourceRegions);
    this.createIdentityMappingsTable(solutionName, processedDataBucket, isMultiRegion, sourceRegions);
    this.createCurCostsTable(solutionName, processedDataBucket, isMultiRegion, sourceRegions);
    this.createReconciledCostsTable(solutionName, processedDataBucket, isMultiRegion, sourceRegions);
    this.createModelBillingMapTable(solutionName, processedDataBucket);

    // ── Athena Workgroup ──────────────────────────────────────────────────────
    const athenaResultsBucket = processedDataBucket;
    const athenaResultsPrefix = `athena-results/${solutionName}/`;

    this.athenaWorkgroup = new athena.CfnWorkGroup(this, 'AthenaWorkgroup', {
      name: `${solutionName}-workgroup`,
      description: `Athena workgroup for ${solutionName} analytics queries`,
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 10 * 1024 * 1024 * 1024, // 10 GB per query
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/${athenaResultsPrefix}`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_KMS',
            kmsKey: cmk.keyArn,
          },
        },
      },
    });

    // Note: ResultReuseConfiguration is not supported in all regions/accounts.
    // Query result reuse can be enabled manually in the Athena console if needed.

    // ── QuickSight (conditional) ──────────────────────────────────────────────
    if (config.dashboard.enableQuickSuite) {
      const qsResources = this.createQuickSightResources(config, solutionName, cmk, isMultiRegion, processedDataBucket);
      this.dataSetId = qsResources.dataSetId;
      this.metricsDataSetId = qsResources.metricsDataSetId;
      this.dataSourceArn = qsResources.dataSourceArn;
    }

    // ── Grant Athena access to processed data bucket ──────────────────────────
    athenaResultsBucket.grantReadWrite(
      new iam.ServicePrincipal('athena.amazonaws.com'),
    );
    cmk.grantEncryptDecrypt(new iam.ServicePrincipal('athena.amazonaws.com'));

    // ── CfnOutputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AthenaWorkgroupName', {
      value: this.athenaWorkgroup.name,
      description: 'Name of the Athena workgroup for querying Bedrock usage data',
      exportName: `${solutionName}-athena-workgroup-name`,
    });

    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: `${solutionName}_analytics`,
      description: 'Name of the Glue database containing analytics tables',
      exportName: `${solutionName}-glue-database-name`,
    });
  }

  // ── Partition projection helpers ──────────────────────────────────────────

  private buildPartitionProjectionParams(
    bucketName: string,
    prefix: string,
    isMultiRegion: boolean,
    sourceRegions: string[],
  ): Record<string, string> {
    const params: Record<string, string> = {
      'projection.enabled': 'true',
      'projection.year.type': 'integer',
      'projection.year.range': '2024,2030',
      'projection.month.type': 'integer',
      'projection.month.range': '1,12',
      'projection.month.digits': '2',
      'projection.day.type': 'integer',
      'projection.day.range': '1,31',
      'projection.day.digits': '2',
      'projection.hour.type': 'integer',
      'projection.hour.range': '0,23',
      'projection.hour.digits': '2',
    };

    if (isMultiRegion) {
      params['projection.region.type'] = 'enum';
      params['projection.region.values'] = sourceRegions.join(',');
      params['storage.location.template'] =
        `s3://${bucketName}/${prefix}/region=\${region}/year=\${year}/month=\${month}/day=\${day}/hour=\${hour}/`;
    } else {
      params['storage.location.template'] =
        `s3://${bucketName}/${prefix}/year=\${year}/month=\${month}/day=\${day}/hour=\${hour}/`;
    }

    return params;
  }

  private buildPartitionKeys(isMultiRegion: boolean): glue.CfnTable.ColumnProperty[] {
    const keys: glue.CfnTable.ColumnProperty[] = [];
    if (isMultiRegion) {
      keys.push({ name: 'region', type: 'string', comment: 'AWS region' });
    }
    keys.push(
      { name: 'year', type: 'string', comment: 'Partition year' },
      { name: 'month', type: 'string', comment: 'Partition month' },
      { name: 'day', type: 'string', comment: 'Partition day' },
      { name: 'hour', type: 'string', comment: 'Partition hour' },
    );
    return keys;
  }

  private parquetStorageDescriptor(
    columns: glue.CfnTable.ColumnProperty[],
    location: string,
  ): glue.CfnTable.StorageDescriptorProperty {
    return {
      columns,
      location,
      inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
      outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
      serdeInfo: {
        serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
      },
    };
  }

  // ── Glue Table: invocation_logs ───────────────────────────────────────────

  private createInvocationLogsTable(
    solutionName: string,
    bucket: s3.Bucket,
    isMultiRegion: boolean,
    sourceRegions: string[],
  ): glue.CfnTable {
    const columns: glue.CfnTable.ColumnProperty[] = [
      { name: 'requestid', type: 'string' },
      { name: 'timestamp', type: 'string' },
      { name: 'accountid', type: 'string' },
      { name: 'modelid', type: 'string' },
      { name: 'resolvedmodelid', type: 'string' },
      { name: 'inputtokens', type: 'bigint' },
      { name: 'outputtokens', type: 'bigint' },
      { name: 'latencyms', type: 'bigint' },
      { name: 'callerarn', type: 'string' },
      { name: 'resolveduserid', type: 'string' },
      { name: 'resolvedusername', type: 'string' },
      { name: 'resolveduseremail', type: 'string' },
      { name: 'agentid', type: 'string' },
      { name: 'agentalias', type: 'string' },
      { name: 'imagecount', type: 'int' },
      { name: 'imagedimensions', type: 'string' },
      { name: 'videodurationseconds', type: 'double' },
      { name: 'videoresolution', type: 'string' },
      { name: 'guardrailid', type: 'string' },
      { name: 'inputcost', type: 'double' },
      { name: 'outputcost', type: 'double' },
      { name: 'totalcost', type: 'double' },
      { name: 'rawrequest', type: 'string' },
      { name: 'rawresponse', type: 'string' },
      { name: 'sourceregion', type: 'string' },
      { name: 'executionregion', type: 'string' },
      { name: 'coststatus', type: 'string', comment: 'Cost reconciliation status: pending, estimated, reconciled, unmatched' },
      { name: 'inferencetier', type: 'string', comment: 'Inference tier: standard, priority, flex, batch' },
      { name: 'cachetype', type: 'string', comment: 'Cache type: none, cacheWrite5m, cacheWrite1h, cacheRead' },
      { name: 'cachewriteinputtokens', type: 'bigint', comment: 'Cache write input token count' },
      { name: 'cachereadinputtokens', type: 'bigint', comment: 'Cache read input token count' },
    ];

    const prefix = 'invocation-logs';
    const params = this.buildPartitionProjectionParams(bucket.bucketName, prefix, isMultiRegion, sourceRegions);

    return new glue.CfnTable(this, 'InvocationLogsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'invocation_logs',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: this.parquetStorageDescriptor(
          columns,
          `s3://${bucket.bucketName}/${prefix}/`,
        ),
        partitionKeys: this.buildPartitionKeys(isMultiRegion),
        parameters: params,
      },
    });
  }

  // ── Glue Table: cloudtrail_events ─────────────────────────────────────────

  private createCloudTrailEventsTable(
    solutionName: string,
    bucket: s3.Bucket,
    isMultiRegion: boolean,
    sourceRegions: string[],
  ): glue.CfnTable {
    const columns: glue.CfnTable.ColumnProperty[] = [
      { name: 'eventid', type: 'string' },
      { name: 'requestid', type: 'string' },
      { name: 'timestamp', type: 'string' },
      { name: 'accountid', type: 'string' },
      { name: 'eventname', type: 'string' },
      { name: 'principalarn', type: 'string' },
      { name: 'sourceipaddress', type: 'string' },
      { name: 'useragent', type: 'string' },
      { name: 'modelid', type: 'string' },
      { name: 'resolveduserid', type: 'string' },
      { name: 'resolvedusername', type: 'string' },
      { name: 'resolveduseremail', type: 'string' },
    ];

    const prefix = 'cloudtrail-events';
    const params = this.buildPartitionProjectionParams(bucket.bucketName, prefix, isMultiRegion, sourceRegions);

    return new glue.CfnTable(this, 'CloudTrailEventsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'cloudtrail_events',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: this.parquetStorageDescriptor(
          columns,
          `s3://${bucket.bucketName}/${prefix}/`,
        ),
        partitionKeys: this.buildPartitionKeys(isMultiRegion),
        parameters: params,
      },
    });
  }

  // ── Glue Table: metrics ───────────────────────────────────────────────────

  private createMetricsTable(
    solutionName: string,
    bucket: s3.Bucket,
    isMultiRegion: boolean,
    sourceRegions: string[],
  ): glue.CfnTable {
    const columns: glue.CfnTable.ColumnProperty[] = [
      { name: 'timestamp', type: 'string' },
      { name: 'region', type: 'string' },
      { name: 'modelid', type: 'string' },
      { name: 'invocationcount', type: 'bigint' },
      { name: 'invocationlatencyavg', type: 'double' },
      { name: 'invocationlatencyp99', type: 'double' },
      { name: 'throttledcount', type: 'bigint' },
      { name: 'errorcount', type: 'bigint' },
    ];

    const prefix = 'metrics';
    const params = this.buildPartitionProjectionParams(bucket.bucketName, prefix, isMultiRegion, sourceRegions);

    return new glue.CfnTable(this, 'MetricsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'metrics',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: this.parquetStorageDescriptor(
          columns,
          `s3://${bucket.bucketName}/${prefix}/`,
        ),
        partitionKeys: this.buildPartitionKeys(isMultiRegion),
        parameters: params,
      },
    });
  }

  // ── Glue Table: identity_mappings ─────────────────────────────────────────

  private createIdentityMappingsTable(
    solutionName: string,
    bucket: s3.Bucket,
    isMultiRegion: boolean,
    sourceRegions: string[],
  ): glue.CfnTable {
    const columns: glue.CfnTable.ColumnProperty[] = [
      { name: 'principalarn', type: 'string' },
      { name: 'sourcetype', type: 'string' },
      { name: 'displayname', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'userid', type: 'string' },
      { name: 'accesskeyid', type: 'string' },
      { name: 'resolvedat', type: 'string' },
    ];

    const prefix = 'identity-mappings';
    const params = this.buildPartitionProjectionParams(bucket.bucketName, prefix, isMultiRegion, sourceRegions);

    return new glue.CfnTable(this, 'IdentityMappingsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'identity_mappings',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: this.parquetStorageDescriptor(
          columns,
          `s3://${bucket.bucketName}/${prefix}/`,
        ),
        partitionKeys: this.buildPartitionKeys(isMultiRegion),
        parameters: params,
      },
    });
  }


  // ── Partition helpers for daily-partitioned tables (no hour partition) ───

  private buildDailyPartitionProjectionParams(
    bucketName: string,
    prefix: string,
  ): Record<string, string> {
    return {
      'projection.enabled': 'true',
      'projection.year.type': 'integer',
      'projection.year.range': '2024,2030',
      'projection.month.type': 'integer',
      'projection.month.range': '1,12',
      'projection.month.digits': '2',
      'projection.day.type': 'integer',
      'projection.day.range': '1,31',
      'projection.day.digits': '2',
      'storage.location.template':
        `s3://${bucketName}/${prefix}/year=\${year}/month=\${month}/day=\${day}/`,
    };
  }

  private buildDailyPartitionKeys(): glue.CfnTable.ColumnProperty[] {
    return [
      { name: 'year', type: 'string', comment: 'Partition year' },
      { name: 'month', type: 'string', comment: 'Partition month' },
      { name: 'day', type: 'string', comment: 'Partition day' },
    ];
  }

  // ── Glue Table: cur_costs ─────────────────────────────────────────────────

  private createCurCostsTable(
    solutionName: string,
    bucket: s3.Bucket,
    isMultiRegion: boolean,
    sourceRegions: string[],
  ): glue.CfnTable {
    const columns: glue.CfnTable.ColumnProperty[] = [
      { name: 'billing_period', type: 'string', comment: 'CUR billing period (YYYY-MM)' },
      { name: 'usage_date', type: 'string', comment: 'Date of usage (ISO 8601)' },
      { name: 'payer_account_id', type: 'string', comment: 'AWS payer account ID' },
      { name: 'usage_account_id', type: 'string', comment: 'AWS usage account ID' },
      { name: 'region', type: 'string', comment: 'AWS region' },
      { name: 'model_billing_name', type: 'string', comment: 'CUR billing name for the model' },
      { name: 'token_type', type: 'string', comment: 'Token type: input-tokens, output-tokens, cache-read-input-token-count, cache-write-input-token-count' },
      { name: 'cross_region_type', type: 'string', comment: 'Cross-region type: none, cross-region-global, cross-region-geo' },
      { name: 'usage_amount', type: 'double', comment: 'Usage amount from CUR' },
      { name: 'unblended_cost', type: 'double', comment: 'CUR unblended cost (authoritative)' },
      { name: 'unblended_rate', type: 'double', comment: 'CUR unblended rate per unit' },
      { name: 'pricing_unit', type: 'string', comment: 'Pricing unit (e.g., 1K tokens, Images, Seconds)' },
      { name: 'item_description', type: 'string', comment: 'CUR line item description' },
      { name: 'cur_file_key', type: 'string', comment: 'Source CUR file S3 key for traceability' },
    ];

    const prefix = 'cur-costs';
    const params = this.buildDailyPartitionProjectionParams(bucket.bucketName, prefix);

    return new glue.CfnTable(this, 'CurCostsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'cur_costs',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: this.parquetStorageDescriptor(
          columns,
          `s3://${bucket.bucketName}/${prefix}/`,
        ),
        partitionKeys: this.buildDailyPartitionKeys(),
        parameters: params,
      },
    });
  }

  // ── Glue Table: reconciled_costs ──────────────────────────────────────────

  private createReconciledCostsTable(
    solutionName: string,
    bucket: s3.Bucket,
    isMultiRegion: boolean,
    sourceRegions: string[],
  ): glue.CfnTable {
    const columns: glue.CfnTable.ColumnProperty[] = [
      { name: 'usage_date', type: 'string', comment: 'Date of usage (ISO 8601)' },
      { name: 'account_id', type: 'string', comment: 'AWS account ID' },
      { name: 'model_id', type: 'string', comment: 'Bedrock API model ID' },
      { name: 'model_billing_name', type: 'string', comment: 'CUR billing name for the model' },
      { name: 'token_type', type: 'string', comment: 'Token type: input-tokens, output-tokens, cache-read-input-token-count, cache-write-input-token-count' },
      { name: 'region', type: 'string', comment: 'AWS region' },
      { name: 'cross_region_type', type: 'string', comment: 'Cross-region type: none, cross-region-global, cross-region-geo' },
      { name: 'resolved_user_id', type: 'string', comment: 'Resolved user ID from identity resolution' },
      { name: 'resolved_user_name', type: 'string', comment: 'Resolved user name from identity resolution' },
      { name: 'user_tokens', type: 'double', comment: 'Token count attributed to this user' },
      { name: 'total_tokens_in_bucket', type: 'double', comment: 'Total tokens in the reconciliation bucket' },
      { name: 'proportion', type: 'double', comment: 'User proportion of total tokens (0 to 1)' },
      { name: 'attributed_cost', type: 'double', comment: 'Proportionally attributed cost from CUR' },
      { name: 'reconciliation_status', type: 'string', comment: 'Status: pending, estimated, reconciled, unmatched' },
    ];

    const prefix = 'reconciled-costs';
    const params = this.buildDailyPartitionProjectionParams(bucket.bucketName, prefix);

    return new glue.CfnTable(this, 'ReconciledCostsTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'reconciled_costs',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: this.parquetStorageDescriptor(
          columns,
          `s3://${bucket.bucketName}/${prefix}/`,
        ),
        partitionKeys: this.buildDailyPartitionKeys(),
        parameters: params,
      },
    });
  }

  // ── Glue Table: model_billing_map ─────────────────────────────────────────

  private createModelBillingMapTable(
    solutionName: string,
    bucket: s3.Bucket,
  ): glue.CfnTable {
    const columns: glue.CfnTable.ColumnProperty[] = [
      { name: 'cur_billing_name', type: 'string', comment: 'CUR billing name (e.g., Claude4.6Opus)' },
      { name: 'bedrock_model_id', type: 'string', comment: 'Bedrock API model ID (e.g., anthropic.claude-opus-4-6-v1)' },
      { name: 'source', type: 'string', comment: 'Mapping source: static or auto' },
      { name: 'last_seen_date', type: 'string', comment: 'Last date this billing name was seen in CUR data' },
    ];

    const prefix = 'model-billing-map';

    return new glue.CfnTable(this, 'ModelBillingMapTable', {
      catalogId: this.account,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'model_billing_map',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: this.parquetStorageDescriptor(
          columns,
          `s3://${bucket.bucketName}/${prefix}/`,
        ),
        parameters: {
          'classification': 'parquet',
        },
      },
    });
  }

  // ── QuickSight resources ──────────────────────────────────────────────────

  private createQuickSightResources(
    config: PlatformConfig,
    solutionName: string,
    cmk: kms.Key,
    isMultiRegion: boolean,
    processedDataBucket: s3.Bucket,
  ): { dataSetId: string; metricsDataSetId: string; dataSourceArn: string } {
    const edition = config.dashboard.quickSuiteEdition ?? 'STANDARD';
    const awsAccountId = this.account;
    const { quickSightPrincipalArn } = config.dashboard;
    const glueDatabaseName = `${solutionName}_analytics`;

    // ── QuickSight Service Role ───────────────────────────────────────────────
    // QuickSight needs a role to pass the DataSource connection test against
    // Athena. The role must be attached to the CfnDataSource via roleArn.
    const qsRole = new iam.Role(this, 'QuickSightServiceRole', {
      roleName: `${solutionName}-quicksight-role`,
      assumedBy: new iam.ServicePrincipal('quicksight.amazonaws.com'),
      description: 'Allows QuickSight to access Athena, S3, and Glue for the analytics datasource',
    });

    // S3: read processed data + write Athena query results (via CDK grant — also updates bucket policy)
    processedDataBucket.grantReadWrite(qsRole);

    // Athena: run queries and get results
    qsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowAthena',
      actions: [
        'athena:BatchGetQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'athena:GetQueryResultsStream',
        'athena:ListQueryExecutions',
        'athena:StartQueryExecution',
        'athena:StopQueryExecution',
        'athena:GetWorkGroup',
      ],
      resources: [
        `arn:aws:athena:${this.region}:${this.account}:workgroup/${solutionName}-workgroup`,
      ],
    }));

    // Glue: read catalog metadata
    qsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowGlue',
      actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions', 'glue:GetTables'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/${glueDatabaseName}`,
        `arn:aws:glue:${this.region}:${this.account}:table/${glueDatabaseName}/*`,
      ],
    }));

    // KMS: decrypt + encrypt (GenerateDataKey needed to write Athena results)
    cmk.grantEncryptDecrypt(qsRole);

    // SPICE is always enabled — hardcoded for all deployments
    const importMode = 'SPICE';

    // Build permissions arrays when quickSightPrincipalArn is provided
    const dataSourcePermissions: quicksight.CfnDataSource.ResourcePermissionProperty[] | undefined =
      quickSightPrincipalArn
        ? [
            {
              principal: quickSightPrincipalArn,
              actions: [
                'quicksight:DescribeDataSource',
                'quicksight:DescribeDataSourcePermissions',
                'quicksight:PassDataSource',
                'quicksight:UpdateDataSource',
                'quicksight:DeleteDataSource',
                'quicksight:UpdateDataSourcePermissions',
              ],
            },
          ]
        : undefined;

    const dataSetPermissions: quicksight.CfnDataSet.ResourcePermissionProperty[] | undefined =
      quickSightPrincipalArn
        ? [
            {
              principal: quickSightPrincipalArn,
              actions: [
                'quicksight:DescribeDataSet',
                'quicksight:DescribeDataSetPermissions',
                'quicksight:PassDataSet',
                'quicksight:DescribeIngestion',
                'quicksight:ListIngestions',
                'quicksight:UpdateDataSet',
                'quicksight:DeleteDataSet',
                'quicksight:CreateIngestion',
                'quicksight:CancelIngestion',
                'quicksight:UpdateDataSetPermissions',
              ],
            },
          ]
        : undefined;

    // QuickSight data source pointing to Athena
    const dataSourceId = `${solutionName}-athena-datasource`;
    const dataSource = new quicksight.CfnDataSource(this, 'QuickSightDataSource', {
      awsAccountId,
      dataSourceId,
      name: `${solutionName} Athena Data Source`,
      type: 'ATHENA',
      dataSourceParameters: {
        athenaParameters: {
          workGroup: this.athenaWorkgroup.name,
          roleArn: qsRole.roleArn,
        },
      },
      sslProperties: {
        disableSsl: false,
      },
      permissions: dataSourcePermissions,
    });

    // Dataset with importMode driven by spiceMode
    const dataSetId = `${solutionName}-invocations-dataset`;
    const dataSet = new quicksight.CfnDataSet(this, 'QuickSightDataSet', {
      awsAccountId,
      dataSetId,
      name: `${solutionName} Invocations Dataset`,
      importMode,
      permissions: dataSetPermissions,
      physicalTableMap: {
        invocationLogs: {
          customSql: {
            dataSourceArn: dataSource.attrArn,
            name: 'invocation_logs',
            sqlQuery: `SELECT il.requestid, from_iso8601_timestamp(il.timestamp) AS timestamp, il.accountid, il.modelid, il.inputtokens, il.outputtokens, il.latencyms, COALESCE(rc.input_cost_per_invocation, 0) AS inputcost, COALESCE(rc.output_cost_per_invocation, 0) AS outputcost, COALESCE(rc.cost_per_invocation, 0) AS totalcost, il.resolveduserid, COALESCE(NULLIF(il.resolvedusername, ''), il.resolveduserid, il.accountid) AS resolvedusername, il.imagecount, il.videodurationseconds, il.sourceregion, il.executionregion, COALESCE(rc.reconciliation_status, 'pending') AS reconciliation_status FROM "${glueDatabaseName}"."invocation_logs" il LEFT JOIN (SELECT inv.accountid AS account_id, CONCAT(inv.year, '-', inv.month, '-', inv.day) AS usage_date, REGEXP_REPLACE(inv.resolvedmodelid, '^(global|us|eu|ap)\\.', '') AS model_id, inv.resolveduserid AS resolved_user_id, COALESCE(costs.total_cost, 0) / CAST(COUNT(*) AS DOUBLE) AS cost_per_invocation, COALESCE(costs.input_cost, 0) / CAST(COUNT(*) AS DOUBLE) AS input_cost_per_invocation, COALESCE(costs.output_cost, 0) / CAST(COUNT(*) AS DOUBLE) AS output_cost_per_invocation, COALESCE(costs.reconciliation_status, 'pending') AS reconciliation_status FROM "${glueDatabaseName}"."invocation_logs" inv LEFT JOIN (SELECT account_id, usage_date, model_id, resolved_user_id, SUM(attributed_cost) AS total_cost, SUM(CASE WHEN token_type IN ('input-tokens','cache-read-input-token-count','cache-write-input-token-count') THEN attributed_cost ELSE 0 END) AS input_cost, SUM(CASE WHEN token_type = 'output-tokens' THEN attributed_cost ELSE 0 END) AS output_cost, MAX(reconciliation_status) AS reconciliation_status FROM "${glueDatabaseName}"."reconciled_costs" GROUP BY account_id, usage_date, model_id, resolved_user_id) costs ON inv.accountid = costs.account_id AND CONCAT(inv.year, '-', inv.month, '-', inv.day) = costs.usage_date AND REGEXP_REPLACE(inv.resolvedmodelid, '^(global|us|eu|ap)\\.', '') = costs.model_id AND inv.resolveduserid = costs.resolved_user_id GROUP BY inv.accountid, CONCAT(inv.year, '-', inv.month, '-', inv.day), REGEXP_REPLACE(inv.resolvedmodelid, '^(global|us|eu|ap)\\.', ''), inv.resolveduserid, costs.total_cost, costs.input_cost, costs.output_cost, costs.reconciliation_status) rc ON il.accountid = rc.account_id AND CONCAT(il.year, '-', il.month, '-', il.day) = rc.usage_date AND REGEXP_REPLACE(il.resolvedmodelid, '^(global|us|eu|ap)\\.', '') = rc.model_id AND il.resolveduserid = rc.resolved_user_id`,
            columns: [
              { name: 'requestid', type: 'STRING' },
              { name: 'timestamp', type: 'DATETIME' },
              { name: 'accountid', type: 'STRING' },
              { name: 'modelid', type: 'STRING' },
              { name: 'inputtokens', type: 'INTEGER' },
              { name: 'outputtokens', type: 'INTEGER' },
              { name: 'latencyms', type: 'INTEGER' },
              { name: 'inputcost', type: 'DECIMAL' },
              { name: 'outputcost', type: 'DECIMAL' },
              { name: 'totalcost', type: 'DECIMAL' },
              { name: 'resolveduserid', type: 'STRING' },
              { name: 'resolvedusername', type: 'STRING' },
              { name: 'imagecount', type: 'INTEGER' },
              { name: 'videodurationseconds', type: 'DECIMAL' },
              { name: 'sourceregion', type: 'STRING' },
              { name: 'executionregion', type: 'STRING' },
              { name: 'reconciliation_status', type: 'STRING' },
            ],
          },
        },
      },
      logicalTableMap: {
        invocationLogs: {
          alias: 'Invocation Logs',
          source: { physicalTableId: 'invocationLogs' },
          dataTransforms: [
            {
              createColumnsOperation: {
                columns: [
                  {
                    columnId: 'calc_total_tokens',
                    columnName: 'totaltokens',
                    expression: '{inputtokens} + {outputtokens}',
                  },
                  {
                    columnId: 'calc_model_name',
                    columnName: 'modelname',
                    // Extract friendly model name from ARN
                    // e.g. "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0" → "anthropic.claude-3-5-sonnet-20240620-v1:0"
                    // e.g. "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1" → "us.anthropic.claude-opus-4-6-v1"
                    // For model IDs without '/' (e.g. direct model IDs), use the full modelid value
                    expression: "ifelse(locate({modelid}, '/') > 0, split({modelid}, '/', 2), {modelid})",
                  },
                ],
              },
            },
            {
              createColumnsOperation: {
                columns: [
                  {
                    columnId: 'calc_friendly_model_name',
                    columnName: 'FriendlyModelName',
                    expression: "ifelse(isNull({modelname}) OR {modelname} = '', replace(replace({modelid}, '.', ' '), '-', ' '), replace(replace({modelname}, '.', ' '), '-', ' '))",
                  },
                ],
              },
            },
          ],
        },
      },
    });

    // ── Dataset Consolidation Investigation (Requirement 12) ────────────────────
    //
    // EVALUATED: Whether InvocationLogs and Metrics datasets can be merged into a
    // single QuickSight dataset using a custom SQL LEFT JOIN query.
    //
    // PROPOSED QUERY:
    //   SELECT il.requestid, il.timestamp, il.accountid, il.modelid,
    //          il.inputtokens, il.outputtokens, il.latencyms,
    //          il.inputcost, il.outputcost, il.totalcost,
    //          il.resolveduserid, il.resolvedusername,
    //          il.imagecount, il.videodurationseconds,
    //          il.sourceregion, il.executionregion,
    //          m.invocationcount, m.invocationlatencyavg, m.invocationlatencyp99,
    //          m.throttledcount, m.errorcount
    //   FROM invocation_logs il
    //   LEFT JOIN metrics m ON il.modelid = m.modelid
    //     AND DATE_TRUNC('hour', il.timestamp) = DATE_TRUNC('hour', m.timestamp)
    //
    // CONCLUSION: NOT FEASIBLE. The two-dataset architecture must be maintained.
    //
    // TECHNICAL LIMITATIONS FOUND:
    //
    // 1. ROW EXPLOSION (critical blocker)
    //    The `metrics` table stores one aggregated row per model per hour (e.g.,
    //    10 models × 24 hours = 240 rows/day). The `invocation_logs` table stores
    //    one row per individual Bedrock API request (potentially millions/day).
    //    A LEFT JOIN on (modelid, DATE_TRUNC('hour', timestamp)) matches every
    //    invocation row against its corresponding metrics row — a 1-to-1 join at
    //    the hour+model granularity. However, if the metrics table ever contains
    //    more than one row per (modelid, hour) bucket (e.g., due to duplicate
    //    CloudWatch metric collection runs), the join becomes many-to-many and
    //    produces N duplicated invocation rows per metrics match. This would cause
    //    all aggregations (SUM of totalcost, COUNT of requestid) to be inflated by
    //    the duplication factor, silently producing incorrect dashboard values.
    //    QuickSight community confirms this is a well-known hazard: "all rows in
    //    table A get duplicated for all rows in table B that satisfy the join
    //    criteria" (community.amazonquicksight.com/t/duplicated-data-in-qs-left-join).
    //
    // 2. SPICE SIZE RISK FROM ROW EXPLOSION
    //    SPICE limits: Standard edition = 25 million rows / 25 GB per dataset;
    //    Enterprise edition = 2 billion rows / 2 TB per dataset (per AWS docs:
    //    docs.aws.amazon.com/quicksight/latest/user/data-source-limits.html).
    //    With row explosion, a high-volume deployment could multiply the
    //    invocation_logs row count by the number of matching metrics rows,
    //    potentially exhausting SPICE capacity and causing ingestion failures.
    //
    // 3. COLUMN NAME PREFIXING WITH LogicalTableMap JOINs
    //    QuickSight's LogicalTableMap JoinInstruction approach (the CDK/CFN API
    //    for dataset-level joins) prefixes column names with the logical table
    //    alias (e.g., `invocationLogs.modelid`, `metrics.errorcount`). This
    //    breaks all existing calculated fields and visual field references that
    //    use bare column names like `{modelid}`, `{totalcost}`, `{errorcount}`.
    //    The alternative — embedding the JOIN in the custom SQL query — avoids
    //    prefixing but does not eliminate the row explosion risk above.
    //
    // 4. IMPACT ON EXISTING VISUALS AND CALCULATED FIELDS
    //    All visuals on the Performance and Service Quota sheets reference
    //    METRICS_DATASET_IDENTIFIER. Consolidation would require updating every
    //    visual's dataSetIdentifier, all calculated field expressions (e.g.,
    //    `ErrorRate = ifelse(sum({invocationcount}) = 0, 0, ...)`, `modelname =
    //    split({modelid}, "/", 2)`), and all filter group dataset references.
    //    This is a high-risk, high-effort change with no correctness guarantee
    //    given the row explosion problem.
    //
    // 5. DIFFERENT DATA GRANULARITIES ARE ARCHITECTURALLY INCOMPATIBLE
    //    invocation_logs is request-level (one row per API call); metrics is
    //    time-series aggregate (one row per model per hour from CloudWatch).
    //    These two granularities serve fundamentally different visual types:
    //    invocation_logs powers per-request KPIs and user-level tables;
    //    metrics powers latency/error-rate KPIs that require pre-aggregated
    //    CloudWatch data. Merging them into one dataset conflates the two
    //    granularities and makes it impossible to aggregate either correctly
    //    without introducing window functions or subqueries that QuickSight's
    //    custom SQL layer does not reliably support across SPICE ingestion.
    //
    // RECOMMENDATION: Maintain the two-dataset architecture. The separation is
    // not incidental complexity — it reflects a genuine difference in data
    // granularity and source system. The Metrics dataset should continue to be
    // defined and ingested independently, as implemented below.
    // ────────────────────────────────────────────────────────────────────────────

    // ── Metrics Dataset ─────────────────────────────────────────────────────────
    const metricsDataSetId = `${solutionName}-metrics-dataset`;
    new quicksight.CfnDataSet(this, 'QuickSightMetricsDataSet', {
      awsAccountId,
      dataSetId: metricsDataSetId,
      name: `${solutionName} Metrics Dataset`,
      importMode,
      permissions: dataSetPermissions,
      physicalTableMap: {
        metrics: {
          customSql: {
            dataSourceArn: dataSource.attrArn,
            name: 'metrics',
            sqlQuery: `SELECT from_iso8601_timestamp(timestamp) AS timestamp, region, modelid, invocationcount, invocationlatencyavg, invocationlatencyp99, throttledcount, errorcount FROM "${glueDatabaseName}"."metrics" WHERE invocationcount > 0 OR throttledcount > 0 OR errorcount > 0`,
            columns: [
              { name: 'timestamp', type: 'DATETIME' },
              { name: 'region', type: 'STRING' },
              { name: 'modelid', type: 'STRING' },
              { name: 'invocationcount', type: 'INTEGER' },
              { name: 'invocationlatencyavg', type: 'DECIMAL' },
              { name: 'invocationlatencyp99', type: 'DECIMAL' },
              { name: 'throttledcount', type: 'INTEGER' },
              { name: 'errorcount', type: 'INTEGER' },
            ],
          },
        },
      },
      logicalTableMap: {
        metrics: {
          alias: 'Metrics',
          source: { physicalTableId: 'metrics' },
          dataTransforms: [
            {
              createColumnsOperation: {
                columns: [
                  {
                    columnId: 'calc_model_name',
                    columnName: 'modelname',
                    // For model IDs without '/' (e.g. direct model IDs), use the full modelid value
                    expression: "ifelse(locate({modelid}, '/') > 0, split({modelid}, '/', 2), {modelid})",
                  },
                ],
              },
            },
            {
              createColumnsOperation: {
                columns: [
                  {
                    columnId: 'calc_friendly_model_name',
                    columnName: 'FriendlyModelName',
                    expression: "ifelse(isNull({modelname}) OR {modelname} = '', replace(replace({modelid}, '.', ' '), '-', ' '), replace(replace({modelname}, '.', ' '), '-', ' '))",
                  },
                ],
              },
            },
          ],
        },
      },
    });

    // Enterprise edition: row-level security
    if (edition === 'ENTERPRISE') {
      new quicksight.CfnDataSet(this, 'RlsDataSet', {
        awsAccountId,
        dataSetId: `${solutionName}-rls-dataset`,
        name: `${solutionName} Row-Level Security Dataset`,
        importMode: 'SPICE',
        physicalTableMap: {
          rlsRules: {
            customSql: {
              dataSourceArn: dataSource.attrArn,
              name: 'rls_rules',
              sqlQuery: `SELECT principalarn, accountid FROM "${solutionName}_analytics"."identity_mappings"`,
              columns: [
                { name: 'principalarn', type: 'STRING' },
                { name: 'accountid', type: 'STRING' },
              ],
            },
          },
        },
        logicalTableMap: {
          rlsRules: {
            alias: 'RLS Rules',
            source: { physicalTableId: 'rlsRules' },
          },
        },
      });

      // Apply row-level security to the main dataset
      const cfnDataSet = dataSet as quicksight.CfnDataSet;
      cfnDataSet.addPropertyOverride('RowLevelPermissionDataSet', {
        Arn: cdk.Fn.sub(
          `arn:aws:quicksight:\${AWS::Region}:\${AWS::AccountId}:dataset/${solutionName}-rls-dataset`,
        ),
        PermissionPolicy: 'GRANT_ACCESS',
        FormatVersion: 'VERSION_2',
      });
    }

    // ── SPICE Refresh Schedules (every 12 hours) ─────────────────────────────
    // SPICE is always enabled — refresh schedules run twice daily to keep
    // dashboard data current while minimizing S3 LIST operations from
    // Athena partition projection scans.
    new quicksight.CfnRefreshSchedule(this, 'InvocationsDataSetRefreshSchedule', {
      awsAccountId,
      dataSetId,
      schedule: {
        scheduleId: `${solutionName}-invocations-refresh`,
        scheduleFrequency: {
          interval: 'DAILY',
          timeOfTheDay: '06:00',
        },
        refreshType: 'FULL_REFRESH',
      },
    });

    new quicksight.CfnRefreshSchedule(this, 'MetricsDataSetRefreshSchedule', {
      awsAccountId,
      dataSetId: metricsDataSetId,
      schedule: {
        scheduleId: `${solutionName}-metrics-refresh`,
        scheduleFrequency: {
          interval: 'DAILY',
          timeOfTheDay: '06:00',
        },
        refreshType: 'FULL_REFRESH',
      },
    });

    return { dataSetId, metricsDataSetId, dataSourceArn: dataSource.attrArn };
  }
}
