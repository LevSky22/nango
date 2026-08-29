import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seeders } from '@nangohq/shared';

import { authenticateUser, isError, isSuccess, runServer, shouldBeProtected } from '../../../utils/tests.js';

const route = '/api/v1/user';
let api: Awaited<ReturnType<typeof runServer>>;
describe(`PATCH ${route}`, () => {
    beforeAll(async () => {
        api = await runServer();
    });
    afterAll(() => {
        api.server.close();
    });

    it('should be protected', async () => {
        const res = await api.fetch(route, { method: 'PATCH', body: { name: 'name' } });

        shouldBeProtected(res);
    });

    it('should enforce no query params', async () => {
        const { apiKey } = await seeders.seedAccountEnvAndUser();
        const res = await api.fetch(route, {
            method: 'PATCH',
            token: apiKey.secret,
            // @ts-expect-error on purpose
            query: { env: 'dev' },
            body: { name: 'name' }
        });

        expect(res.res.status).toBe(400);
        isError(res.json);
        expect(res.json).toStrictEqual<typeof res.json>({
            error: {
                code: 'invalid_query_params',
                errors: [{ code: 'unrecognized_keys', message: 'Unrecognized key: "env"', path: [] }]
            }
        });
    });

    it('should patch a user and keep the current session authenticated', async () => {
        const { user } = await seeders.seedAccountEnvAndUser();
        const session = await authenticateUser(api, user);
        const name = 'Updated Name';

        const updated = await api.fetch(route, {
            method: 'PATCH',
            session,
            body: { name }
        });

        expect(updated.res.status).toBe(200);
        isSuccess(updated.json);
        expect(updated.json.data.name).toBe(name);

        const fetched = await api.fetch(route, { method: 'GET', session });
        expect(fetched.res.status).toBe(200);
        isSuccess(fetched.json);
        expect(fetched.json.data.name).toBe(name);
    });
});
