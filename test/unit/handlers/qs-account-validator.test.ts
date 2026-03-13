// Feature: quicksight-dashboard
// Unit tests for QS Account Validator handler
// Requirements: 8

import { mockClient } from 'aws-sdk-client-mock';
import {
  QuickSightClient,
  DescribeAccountSubscriptionCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-quicksight';

const qsMock = mockClient(QuickSightClient);

import { handler } from 'lib/handlers/qs-account-validator/index';

function makeEvent(
  requestType: 'Create' | 'Update' | 'Delete',
  physicalResourceId?: string,
  accountId = '123456789012',
) {
  return {
    RequestType: requestType,
    PhysicalResourceId: physicalResourceId,
    ResourceProperties: { AwsAccountId: accountId } as Record<string, string>,
  };
}

beforeEach(() => {
  qsMock.reset();
});

describe('QS Account Validator handler', () => {
  describe('CREATE event', () => {
    it('returns PhysicalResourceId on successful subscription validation', async () => {
      qsMock.on(DescribeAccountSubscriptionCommand).resolves({
        AccountInfo: { AccountSubscriptionStatus: 'ACCOUNT_CREATED' },
        $metadata: { httpStatusCode: 200 },
      });

      const result = await handler(makeEvent('Create'));

      expect(result.PhysicalResourceId).toBe('qs-account-validator');
      const calls = qsMock.commandCalls(DescribeAccountSubscriptionCommand);
      expect(calls).toHaveLength(1);
    });

    it('throws when ResourceNotFoundException is returned', async () => {
      qsMock.on(DescribeAccountSubscriptionCommand).rejects(
        new ResourceNotFoundException({ message: 'Account not found', $metadata: {} }),
      );

      await expect(handler(makeEvent('Create'))).rejects.toThrow(
        'QuickSight account is not activated',
      );
    });

    it('throws when subscription status is not ACCOUNT_CREATED', async () => {
      qsMock.on(DescribeAccountSubscriptionCommand).resolves({
        AccountInfo: { AccountSubscriptionStatus: 'UNSUBSCRIBED' },
        $metadata: { httpStatusCode: 200 },
      });

      await expect(handler(makeEvent('Create'))).rejects.toThrow(
        'QuickSight account is not activated',
      );
    });

    it('throws when AccountInfo is missing', async () => {
      qsMock.on(DescribeAccountSubscriptionCommand).resolves({
        AccountInfo: undefined,
        $metadata: { httpStatusCode: 200 },
      });

      await expect(handler(makeEvent('Create'))).rejects.toThrow(
        'QuickSight account is not activated',
      );
    });
  });

  describe('UPDATE event', () => {
    it('returns PhysicalResourceId on successful subscription validation', async () => {
      qsMock.on(DescribeAccountSubscriptionCommand).resolves({
        AccountInfo: { AccountSubscriptionStatus: 'ACCOUNT_CREATED' },
        $metadata: { httpStatusCode: 200 },
      });

      const result = await handler(makeEvent('Update', 'qs-account-validator'));

      expect(result.PhysicalResourceId).toBe('qs-account-validator');
      const calls = qsMock.commandCalls(DescribeAccountSubscriptionCommand);
      expect(calls).toHaveLength(1);
    });

    it('throws when ResourceNotFoundException is returned on UPDATE', async () => {
      qsMock.on(DescribeAccountSubscriptionCommand).rejects(
        new ResourceNotFoundException({ message: 'Account not found', $metadata: {} }),
      );

      await expect(handler(makeEvent('Update', 'qs-account-validator'))).rejects.toThrow(
        'QuickSight account is not activated',
      );
    });
  });

  describe('DELETE event', () => {
    it('is a no-op and returns PhysicalResourceId without calling QuickSight', async () => {
      const result = await handler(makeEvent('Delete', 'qs-account-validator'));

      expect(result.PhysicalResourceId).toBe('qs-account-validator');
      const calls = qsMock.commandCalls(DescribeAccountSubscriptionCommand);
      expect(calls).toHaveLength(0);
    });

    it('returns the provided PhysicalResourceId on DELETE', async () => {
      const result = await handler(makeEvent('Delete', 'custom-physical-id'));

      expect(result.PhysicalResourceId).toBe('custom-physical-id');
    });
  });

  describe('Error propagation', () => {
    it('re-throws non-ResourceNotFoundException errors from QuickSight', async () => {
      qsMock.on(DescribeAccountSubscriptionCommand).rejects(new Error('AccessDeniedException'));

      await expect(handler(makeEvent('Create'))).rejects.toThrow('AccessDeniedException');
    });
  });
});
