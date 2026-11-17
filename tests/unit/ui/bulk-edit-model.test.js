import { describe, expect, it } from 'vitest';

import {
    buildApplyPayload,
    buildPlanPayload,
    capabilityStatusRank,
    collectExistingFields,
    combineCapabilityStatuses,
    formatChange,
    formatExistingFieldSummary,
    formatExistingFieldValues,
    formatPlannedChanges,
    groupExistingFields,
    operationRequiresLocator,
    operationRequiresValue,
    planHasChanges,
    resolveCapabilityStatus,
    summarizeApplyResults,
    summarizeCapabilities,
} from '../../../src/ui/bulk-edit-model.js';

describe('bulk edit capability precedence', () => {
    it('ranks error above unsupported above noop above supported', () => {
        expect(capabilityStatusRank('error')).toBeGreaterThan(capabilityStatusRank('unsupported'));
        expect(capabilityStatusRank('unsupported')).toBeGreaterThan(capabilityStatusRank('noop'));
        expect(capabilityStatusRank('noop')).toBeGreaterThan(capabilityStatusRank('supported'));
    });

    it('treats unknown statuses as errors', () => {
        expect(capabilityStatusRank('something-new')).toBe(capabilityStatusRank('error'));
    });

    it('picks the most severe status for a mixed batch', () => {
        expect(combineCapabilityStatuses(['supported', 'noop', 'unsupported'])).toBe('unsupported');
        expect(combineCapabilityStatuses(['supported', 'noop', 'error'])).toBe('error');
        expect(combineCapabilityStatuses(['supported', 'supported'])).toBe('supported');
        expect(combineCapabilityStatuses([])).toBe('supported');
    });

    it('resolves a row status from explicit status or its operations', () => {
        expect(resolveCapabilityStatus({ status: 'noop', operations: ['exif_set_tag'] })).toBe('noop');
        expect(resolveCapabilityStatus({ operations: ['exif_set_tag'] })).toBe('unsupported');
        expect(resolveCapabilityStatus({ operations: [] })).toBe('error');
        expect(resolveCapabilityStatus(null)).toBe('error');
    });

    it('summarizes a mixed capability response', () => {
        const summary = summarizeCapabilities({
            operations: [{ operation: 'exif_set_tag' }],
            files: [
                { file: '/a.jpg', status: 'supported' },
                { file: '/b.jpg', status: 'unsupported' },
                { file: '/c.txt', status: 'error' },
                { file: '/d.jpg', status: 'noop' },
            ],
        });

        expect(summary.total).toBe(4);
        expect(summary.supported).toBe(1);
        expect(summary.unsupported).toBe(1);
        expect(summary.error).toBe(1);
        expect(summary.noop).toBe(1);
        expect(summary.overallStatus).toBe('error');
        expect(summary.operations).toHaveLength(1);
    });
});

describe('bulk edit operation inputs', () => {
    const capabilities = {
        operations: [
            { operation: 'exif_strip', requires_locator: false, requires_value: false },
            { operation: 'exif_set_tag', requires_locator: true, requires_value: true },
            { operation: 'json_set_path', requires_locator: true, requires_value: true },
            { operation: 'fits_set_keyword', requires_locator: true, requires_value: true },
        ],
    };

    it('reads locator and value requirements from the capability matrix', () => {
        expect(operationRequiresLocator(capabilities, 'exif_strip')).toBe(false);
        expect(operationRequiresValue(capabilities, 'exif_strip')).toBe(false);
        expect(operationRequiresLocator(capabilities, 'exif_set_tag')).toBe(true);
        expect(operationRequiresValue(capabilities, 'exif_set_tag')).toBe(true);
        expect(operationRequiresLocator(capabilities, 'json_set_path')).toBe(true);
        expect(operationRequiresValue(capabilities, 'json_set_path')).toBe(true);
        expect(operationRequiresLocator(capabilities, 'fits_set_keyword')).toBe(true);
        expect(operationRequiresValue(capabilities, 'fits_set_keyword')).toBe(true);
    });

    it('keeps the requirement for an unknown or unselected operation', () => {
        expect(operationRequiresLocator(capabilities, 'something_new')).toBe(true);
        expect(operationRequiresValue(capabilities, '')).toBe(true);
        expect(operationRequiresLocator(null, 'exif_strip')).toBe(true);
    });
});

describe('bulk edit existing-field discovery', () => {
    const capabilities = {
        operations: [
            { operation: 'json_set_path', label: 'Character-card JSON field' },
            { operation: 'fits_set_keyword', label: 'FITS keyword' },
        ],
        files: [
            {
                file: '/data/a.fits',
                file_name: 'a.fits',
                existing_fields: [
                    { operation: 'fits_set_keyword', locator: 'OBJECT', value: "'M31'" },
                    { operation: 'fits_set_keyword', locator: 'OBSERVER', value: "'nick'" },
                ],
            },
            {
                file: '/data/b.fits',
                file_name: 'b.fits',
                existing_fields: [
                    { operation: 'fits_set_keyword', locator: 'OBJECT', value: "'M31'" },
                ],
            },
            {
                file: '/data/c.fits',
                file_name: 'c.fits',
                existing_fields: [
                    { operation: 'fits_set_keyword', locator: 'OBJECT', value: "'M42'" },
                    { operation: 'fits_set_keyword', locator: 'EXPTIME', value: '30.0' },
                    { operation: 'fits_set_keyword', locator: '', value: 'skipped' },
                    null,
                ],
            },
            {
                file: '/data/card.png',
                file_name: 'card.png',
                existing_fields: [
                    { operation: 'json_set_path', locator: '/data/creator', value: 'nick' },
                    { operation: 'json_set_path', locator: '/data/name', value: 'Card' },
                ],
            },
            { file: '/data/unreadable.png', file_name: 'unreadable.png', existing_fields: [] },
        ],
    };

    it('groups one locator across files and lists every distinct value', () => {
        const groups = groupExistingFields(capabilities);
        expect(groups).toHaveLength(5);

        const object = groups.find((group) => group.locator === 'OBJECT');
        expect(object.operation).toBe('fits_set_keyword');
        expect(object.fileCount).toBe(3);
        expect(object.values).toEqual([
            { value: "'M31'", count: 2 },
            { value: "'M42'", count: 1 },
        ]);
        expect(formatExistingFieldValues(object.values)).toBe("'M31' (2), 'M42' (1)");
        expect(formatExistingFieldSummary(object)).toBe("OBJECT: 'M31' (2), 'M42' (1)");
    });

    it('sorts locators deterministically and merges both format groups', () => {
        expect(groupExistingFields(capabilities).map((group) => group.locator))
            .toEqual(['/data/creator', '/data/name', 'EXPTIME', 'OBJECT', 'OBSERVER']);
    });

    it('filters grouping to the writer that owns the locator', () => {
        const fits = groupExistingFields(capabilities, 'fits_set_keyword');
        expect(fits.map((group) => group.locator)).toEqual(['EXPTIME', 'OBJECT', 'OBSERVER']);

        const json = groupExistingFields(capabilities, 'json_set_path');
        expect(json.map((group) => group.locator)).toEqual(['/data/creator', '/data/name']);

        expect(collectExistingFields(capabilities, 'json_set_path')).toHaveLength(2);
        expect(groupExistingFields(capabilities, 'unknown_operation')).toEqual([]);
    });

    it('omits counts for a locator present once and marks empty values', () => {
        const observer = groupExistingFields(capabilities, 'fits_set_keyword')
            .find((group) => group.locator === 'OBSERVER');
        expect(formatExistingFieldValues(observer.values)).toBe("'nick'");
        expect(formatExistingFieldValues([{ value: '', count: 1 }])).toBe('∅');
        expect(formatExistingFieldValues([])).toBe('');
        expect(formatExistingFieldSummary(null)).toBe('');
    });

    it('tolerates missing discovery data', () => {
        expect(groupExistingFields(null)).toEqual([]);
        expect(groupExistingFields({ files: [] })).toEqual([]);
        expect(collectExistingFields({ files: [{ file: '/a' }] })).toEqual([]);
    });
});

describe('bulk edit payloads', () => {
    it('builds the exact plan request with sorted paths', () => {
        const payload = buildPlanPayload(['/data/b.jpg', '/data/a.jpg'], {
            operation: 'exif_set_tag',
            locator: ' Artist ',
            value: 'New',
        });

        expect(payload).toEqual({
            request: {
                paths: ['/data/a.jpg', '/data/b.jpg'],
                params: { operation: 'exif_set_tag', locator: 'Artist', value: 'New' },
            },
        });
    });

    it('passes an escaped JSON Pointer through after trimming', () => {
        const payload = buildPlanPayload(['/data/card.json'], {
            operation: 'json_set_path',
            locator: ' /data/weird~1key/tilde~0key ',
            value: 'New',
        });

        expect(payload.request.params).toEqual({
            operation: 'json_set_path',
            locator: '/data/weird~1key/tilde~0key',
            value: 'New',
        });
    });

    it('passes the reviewed plan through unchanged on apply', () => {
        const plan = { schema_version: 1, id: 'abc', params: {}, files: [] };

        const payload = buildApplyPayload(plan);

        expect(payload).toEqual({ plan });
        expect(payload.plan).toBe(plan);
    });

    it('only treats changed rows as applicable work', () => {
        expect(planHasChanges({ files: [{ status: 'noop' }, { status: 'unsupported' }] })).toBe(false);
        expect(planHasChanges({ files: [{ status: 'noop' }, { status: 'changed' }] })).toBe(true);
        expect(planHasChanges(null)).toBe(false);
    });
});

describe('bulk edit review formatting', () => {
    it('renders old and new values, including absent values', () => {
        expect(formatChange({ old_value: 'Old', new_value: 'New' })).toBe('Old → New');
        expect(formatChange({ old_value: null, new_value: 'New' })).toBe('∅ → New');
        expect(formatChange(null)).toBe('');
    });

    it('lists every change of a planned file', () => {
        expect(formatPlannedChanges({
            changes: [
                { locator: 'Artist', old_value: 'A', new_value: 'B' },
                { locator: 'Subject', old_value: null, new_value: 'C' },
            ],
        })).toBe('Artist: A → B; Subject: ∅ → C');

        expect(formatPlannedChanges({ changes: [] })).toBe('—');
    });
});

describe('bulk edit result summary', () => {
    it('keeps applied, skipped, no-op, and failed files distinct', () => {
        const summary = summarizeApplyResults({
            applied: 2,
            skipped: 2,
            failed: 1,
            journal_path: '/app/bulk-edit-journal.jsonl',
            journal_degraded: false,
            results: [
                { file: '/data/a.jpg', status: 'applied', changes: 1, reason: null },
                { file: '/data/b.jpg', status: 'applied', changes: 1, reason: null },
                { file: '/data/c.jpg', status: 'skipped', changes: 0, reason: 'Requested values already match the file.' },
                { file: '/data/e.jpg', status: 'skipped', changes: 0, reason: 'No bulk write is implemented for exif files yet.' },
                { file: '/data/d.jpg', status: 'failed', changes: 0, reason: 'stale_content: file content changed since the plan was reviewed.' },
            ],
        });

        expect(summary.total).toBe(5);
        expect(summary.applied).toBe(2);
        expect(summary.skipped).toBe(2);
        expect(summary.noop).toBe(1);
        expect(summary.failed).toBe(1);
        expect(summary.hasFailures).toBe(true);
        expect(summary.summaryLine).toBe('2 applied, 2 skipped (1 no-op), 1 failed');
        expect(summary.lines[0]).toBe('a.jpg — applied');
        expect(summary.lines[4]).toBe(
            'd.jpg — failed: stale_content: file content changed since the plan was reviewed.'
        );
        expect(summary.journalPath).toBe('/app/bulk-edit-journal.jsonl');
        expect(summary.journalDegraded).toBe(false);
    });

    it('derives counts from results when totals are missing', () => {
        const summary = summarizeApplyResults({
            results: [
                { file: '/a.jpg', status: 'applied' },
                { file: '/b.jpg', status: 'failed', reason: 'write_failed' },
            ],
        });

        expect(summary.applied).toBe(1);
        expect(summary.failed).toBe(1);
        expect(summary.skipped).toBe(0);
        expect(summary.summaryLine).toBe('1 applied, 0 skipped, 1 failed');
    });

    it('flags a degraded journal in the summary', () => {
        const summary = summarizeApplyResults({
            applied: 1,
            skipped: 0,
            failed: 0,
            journal_degraded: true,
            results: [{ file: '/a.jpg', status: 'applied' }],
        });

        expect(summary.journalDegraded).toBe(true);
        expect(summary.hasFailures).toBe(false);
    });

    it('handles an empty result', () => {
        expect(summarizeApplyResults(null)).toMatchObject({
            total: 0,
            applied: 0,
            skipped: 0,
            failed: 0,
            noop: 0,
            hasFailures: false,
            journalPath: null,
        });
    });
});
