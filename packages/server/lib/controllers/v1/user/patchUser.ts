import * as z from 'zod';

import { userService } from '@nangohq/shared';
import { requireEmptyQuery, zodErrorToHTTP } from '@nangohq/utils';

import { userToAPI } from '../../../formatters/user.js';
import { asyncWrapper } from '../../../utils/asyncWrapper.js';

import type { DBUser, PatchUser } from '@nangohq/types';

const validation = z
    .object({
        name: z.string().min(3).max(255).optional(),
        gettingStartedClosed: z.boolean().optional()
    })
    .strict();

export const patchUser = asyncWrapper<PatchUser, never>(async (req, res) => {
    const emptyQuery = requireEmptyQuery(req);
    if (emptyQuery) {
        res.status(400).send({ error: { code: 'invalid_query_params', errors: zodErrorToHTTP(emptyQuery.error) } });
        return;
    }

    const val = validation.safeParse(req.body);
    if (!val.success) {
        res.status(400).send({
            error: { code: 'invalid_body', errors: zodErrorToHTTP(val.error) }
        });
        return;
    }

    const user = res.locals['user'] as DBUser; // type is slightly wrong because we are not in an endpoint with an ?env=
    const body: PatchUser['Body'] = val.data;

    const update: Partial<DBUser> & Pick<DBUser, 'id'> = {
        id: user.id
    };

    if (body.name !== undefined) {
        update.name = body.name;
    }

    if (body.gettingStartedClosed !== undefined) {
        update.getting_started_closed = body.gettingStartedClosed;
    }

    const updated = await userService.update(update);
    if (!updated) {
        res.status(500).send({ error: { code: 'server_error', message: 'failed to update user' } });
        return;
    }

    // Authentication middleware reloads the user from the database; Basic auth has no persistent Passport session.
    res.status(200).send({
        data: userToAPI(updated)
    });
});
