import type * as mongooseType from 'mongoose';

export async function connectToDatabase(mongoose: typeof mongooseType): Promise<void> {
    const mongooseOpts = {
        useNewUrlParser: true,
        useCreateIndex: true,
        useUnifiedTopology: true
    };

    // MONGO_URL is set by jest-mongodb
    return new Promise((resolve, reject) => {
        mongoose.connect(process.env.MONGO_URL!, mongooseOpts, (err) => {
            if (err) {
                reject(err);
            }
            resolve();
        });
    });
}

export async function closeDatabase(mongoose: typeof mongooseType): Promise<void> {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
}

export async function clearDatabase(mongoose: typeof mongooseType): Promise<void> {
    const collections = mongoose.connection.collections;

    for (const collection of Object.values(collections)) {
        await collection.deleteMany({});
    }
}
