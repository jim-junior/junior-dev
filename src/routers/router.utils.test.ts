import { hasOrganizationAccess } from './router.utils';
import type { Request, Response, NextFunction } from 'express';
import type { IOrganizationMembership } from '../models/user.model';
import mongoose from 'mongoose';

describe('router.utils', () => {
    test('hasOrganizationAccess', async () => {
        expect.hasAssertions();
        const orgId = mongoose.Types.ObjectId();
        const req = {
            isAuthenticated: () => true,
            params: {
                id: orgId
            },
            user: {
                organizationMemberships: [] as IOrganizationMembership[]
            }
        };
        const json = jest.fn();
        const res = {
            status: jest.fn().mockReturnValue({ json })
        };
        const next = jest.fn();

        // no access
        hasOrganizationAccess(req as unknown as Request, res as unknown as Response, next as NextFunction);
        expect(next.mock.calls).toHaveLength(0);
        expect(res.status.mock.calls).toHaveLength(1);
        expect(res.status.mock.calls[0][0]).toBe(401);

        // shall pass
        const membership = { organizationId: orgId } as unknown as IOrganizationMembership;
        req.user.organizationMemberships = [membership];
        hasOrganizationAccess(req as unknown as Request, res as unknown as Response, next as NextFunction);
        expect(next.mock.calls).toHaveLength(1);
    });
});
