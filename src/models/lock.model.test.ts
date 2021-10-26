import mongoose from 'mongoose';
import Lock from './lock.model';
import { connectToDatabase, clearDatabase, closeDatabase } from '../test-utils/mongo';

describe('Lock Model', () => {
    beforeAll(() => connectToDatabase(mongoose));
    beforeEach(() => clearDatabase(mongoose));
    afterAll(() => closeDatabase(mongoose));

    test('statics.acquire', async () => {
        expect.assertions(3);
        expect(await Lock.acquire('test-lock')).toBeTruthy();
        expect(await Lock.acquire('test-lock')).toBeFalsy();
        expect(await Lock.acquire('test-lock')).toBeFalsy();
    });

    test('statics.acquire & statics.release', async () => {
        expect.assertions(2);
        expect(await Lock.acquire('test-lock')).toBeTruthy();
        await Lock.release('test-lock');
        expect(await Lock.acquire('test-lock')).toBeTruthy();
        await Lock.release('test-lock2'); // checking that it doesn't fail
    });
});
