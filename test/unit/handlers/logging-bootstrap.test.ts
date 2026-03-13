// Feature: bedrock-usage-intelligence
// Unit tests for Logging Bootstrap handler
// Requirements: 5.1
//
// The handler is invoked by the CDK Provider framework, NOT directly by
// CloudFormation. It returns { PhysicalResourceId } on success or throws
// on failure. The Provider framework handles the cfn-response callback.

import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockClient,
  PutModelInvocationLoggingConfigurationCommand,
  DeleteModelInvocationLoggingConfigurationCommand,
} from '@aws-sdk/client-bedrock';

const bedrockMock = mockClient(BedrockClient);

function makeEvent(
  requestType: 'Create' | 'Update' | 'Delete',
  physicalResourceId?: string,
) {
  return {
    RequestType: requestType,
    PhysicalResourceId: physicalResourceId,
    ResourceProperties: {} as Record<string, string>,
  };
}

import { handler } from 'lib/handlers/logging-bootstrap/index';

beforeEach(() => {
  bedrockMock.reset();
});

describe('Logging Bootstrap handler', () => {
  describe('CREATE event', () => {
    it('calls PutModelInvocationLoggingConfiguration and returns PhysicalResourceId', async () => {
      bedrockMock.on(PutModelInvocationLoggingConfigurationCommand).resolves({});

      const result = await handler(makeEvent('Create'));

      expect(result.PhysicalResourceId).toBe('bedrock-invocation-logging-config');

      const calls = bedrockMock.commandCalls(PutModelInvocationLoggingConfigurationCommand);
      expect(calls).toHaveLength(1);
    });

    it('uses existing PhysicalResourceId when provided', async () => {
      bedrockMock.on(PutModelInvocationLoggingConfigurationCommand).resolves({});

      const result = await handler(makeEvent('Create', 'existing-physical-id'));

      expect(result.PhysicalResourceId).toBe('existing-physical-id');
    });
  });

  describe('UPDATE event', () => {
    it('calls PutModelInvocationLoggingConfiguration and returns PhysicalResourceId', async () => {
      bedrockMock.on(PutModelInvocationLoggingConfigurationCommand).resolves({});

      const result = await handler(makeEvent('Update', 'existing-physical-id'));

      expect(result.PhysicalResourceId).toBe('existing-physical-id');
      const calls = bedrockMock.commandCalls(PutModelInvocationLoggingConfigurationCommand);
      expect(calls).toHaveLength(1);
    });
  });

  describe('DELETE event', () => {
    it('does NOT call DeleteModelInvocationLoggingConfiguration when DISABLE_ON_DELETE is not set', async () => {
      delete process.env['DISABLE_ON_DELETE'];
      const result = await handler(makeEvent('Delete', 'existing-physical-id'));

      expect(result.PhysicalResourceId).toBe('existing-physical-id');
      const calls = bedrockMock.commandCalls(DeleteModelInvocationLoggingConfigurationCommand);
      expect(calls).toHaveLength(0);
    });

    it('calls DeleteModelInvocationLoggingConfiguration when DISABLE_ON_DELETE=true', async () => {
      process.env['DISABLE_ON_DELETE'] = 'true';
      bedrockMock.on(DeleteModelInvocationLoggingConfigurationCommand).resolves({});

      const result = await handler(makeEvent('Delete', 'existing-physical-id'));

      expect(result.PhysicalResourceId).toBe('existing-physical-id');
      const calls = bedrockMock.commandCalls(DeleteModelInvocationLoggingConfigurationCommand);
      expect(calls).toHaveLength(1);

      delete process.env['DISABLE_ON_DELETE'];
    });

    it('throws when Bedrock API fails on DELETE with DISABLE_ON_DELETE=true', async () => {
      process.env['DISABLE_ON_DELETE'] = 'true';
      bedrockMock
        .on(DeleteModelInvocationLoggingConfigurationCommand)
        .rejects(new Error('ServiceUnavailable'));

      await expect(handler(makeEvent('Delete', 'existing-physical-id'))).rejects.toThrow(
        'ServiceUnavailable',
      );

      delete process.env['DISABLE_ON_DELETE'];
    });
  });

  describe('Error handling', () => {
    it('throws when Bedrock API fails on CREATE', async () => {
      bedrockMock
        .on(PutModelInvocationLoggingConfigurationCommand)
        .rejects(new Error('AccessDeniedException'));

      await expect(handler(makeEvent('Create'))).rejects.toThrow('AccessDeniedException');
    });

    it('throws when Bedrock API fails on UPDATE', async () => {
      bedrockMock
        .on(PutModelInvocationLoggingConfigurationCommand)
        .rejects(new Error('ServiceUnavailable'));

      await expect(handler(makeEvent('Update', 'existing-physical-id'))).rejects.toThrow(
        'ServiceUnavailable',
      );
    });
  });
});
