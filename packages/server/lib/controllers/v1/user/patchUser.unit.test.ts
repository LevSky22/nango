import { beforeEach, describe, expect, it, vi } from 'vitest';

import { patchUser } from './patchUser.js';

import type { DBUser } from '@nangohq/types';
import type { NextFunction, Request, Response } from 'express';

const { mockUpdateUser } = vi.hoisted(() => ({
    mockUpdateUser: vi.fn()
}));

vi.mock('@nangohq/shared', () => ({
    userService: {
        update: mockUpdateUser
    }
}));

const user = {
    id: 1,
    account_id: 2,
    email: 'user@example.com',
    name: 'Previous Name',
    uuid: 'user-uuid',
    role: 'administrator',
    getting_started_closed: false
} as DBUser;

describe('patchUser', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUpdateUser.mockResolvedValue({ ...user, name: 'Updated Name' });
    });

    it('updates the user without a persistent Passport session', async () => {
        const req = {
            body: { name: 'Updated Name' },
            header: vi.fn(),
            originalUrl: '/api/v1/user',
            query: {},
            route: { path: '/api/v1/user' },
            session: {}
        } as unknown as Request;
        const status = vi.fn().mockReturnThis();
        const send = vi.fn().mockReturnThis();
        const res = {
            locals: { user },
            send,
            status
        } as unknown as Response;
        const next = vi.fn() as NextFunction;

        await patchUser(req, res, next);

        expect(mockUpdateUser).toHaveBeenCalledWith({ id: user.id, name: 'Updated Name' });
        expect(next).not.toHaveBeenCalled();
        expect(status).toHaveBeenCalledWith(200);
        expect(send).toHaveBeenCalledWith({
            data: {
                accountId: user.account_id,
                email: user.email,
                gettingStartedClosed: user.getting_started_closed,
                id: user.id,
                name: 'Updated Name',
                role: user.role,
                uuid: user.uuid
            }
        });
    });
});
