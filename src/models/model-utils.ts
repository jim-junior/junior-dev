import _ from 'lodash';
import { Document, Model, Schema, Types } from 'mongoose';

type AnyFunction = (...args: any[]) => any;

export function docArrayPush<M extends Document, C extends keyof M, I, _CT extends M[C] & Record<number, I>>(
    model: M,
    collection: C,
    item: Partial<I>
): void {
    (model[collection] as unknown as Types.DocumentArray<I & Types.Subdocument>).push(item);
}

export function makeSetUnsetUpdateObj(deepPath: string, update: any, { inc }: any = {}): any {
    const $set = _.reduce(
        update,
        function (result: any, value, key) {
            if (value !== null) {
                result[`${deepPath}.${key}`] = value;
            }
            return result;
        },
        {}
    );

    const $unset = _.reduce(
        update,
        function (result: any, value, key) {
            if (value === null) {
                result[`${deepPath}.${key}`] = '';
            }
            return result;
        },
        {}
    );

    const $inc = _.reduce(
        inc,
        function (result: any, value, key) {
            if (value !== null) {
                result[`${deepPath}.${key}`] = value;
            }
            return result;
        },
        {}
    );

    const updateObj: any = {};
    if (Object.keys($set).length) {
        updateObj.$set = $set;
    }
    if (Object.keys($unset).length) {
        updateObj.$unset = $unset;
    }

    if (Object.keys($inc).length) {
        updateObj.$inc = $unset;
    }

    return updateObj;
}

interface TypeSafeVirtualDefinition<Doc extends Document<Id>, Id> {
    <Name extends keyof Doc & string, Virt extends Doc[Name]>(
        name: Name,
        func: Doc[Name] extends AnyFunction ? never : (this: Doc) => Virt
    ): void;
    <Name1 extends keyof Doc & string, Name2 extends keyof Doc[Name1] & string, Virt extends Doc[Name1][Name2]>(
        name1: Name1,
        name2: Name2,
        func: Doc[Name1][Name2] extends AnyFunction ? never : (this: Doc) => Virt
    ): void;
    <
        Name1 extends keyof Doc & string,
        Name2 extends keyof Doc[Name1] & string,
        Name3 extends keyof Doc[Name1][Name2] & string,
        Virt extends Doc[Name1][Name2][Name3]
    >(
        name1: Name1,
        name2: Name2,
        name3: Name3,
        func: Doc[Name1][Name2][Name3] extends AnyFunction ? never : (this: Doc) => Virt
    ): void;
}

type TypeSafeMethods<Doc extends Document<Id>, Id> = {
    [name in keyof Doc]: (Doc[name] extends AnyFunction ? Doc[name] : never) extends (...args: infer Args) => infer Ret
        ? (this: Doc, ...args: Args) => Ret
        : never;
};

type TypeSafeStatics<Doc extends Document<Id>, Mod extends Model<Doc>, Id> = {
    [name in keyof Mod]: (Mod[name] extends AnyFunction ? Mod[name] : never) extends (...args: infer Args) => infer Ret
        ? (this: Mod, ...args: Args) => Ret
        : never;
};

export type TypeSafeSchema<Doc extends Document<Id>, Mod extends Model<Doc>, Id> = Omit<Schema<Doc, Mod>, 'methods' | 'statics'> & {
    methods: TypeSafeMethods<Doc, Id>;
    statics: TypeSafeStatics<Doc, Mod, Id>;
    typeSafeVirtual: TypeSafeVirtualDefinition<Doc, Id>;
    unsafeSchema: Schema<Doc, Mod>;
};

export function makeTypeSafeSchema<Doc extends Document<Id>, Mod extends Model<Doc>, Id = Doc extends Document<infer I> ? I : never>(
    schema: Schema<Doc, Mod>
): TypeSafeSchema<Doc, Mod, Id> {
    const typeSafeSchema = schema as TypeSafeSchema<Doc, Mod, Id>;
    typeSafeSchema.typeSafeVirtual = (name1: string, name2: string | AnyFunction, name3?: string | AnyFunction, func?: AnyFunction) => {
        schema
            .virtual([name1, typeof name2 === 'string' && name2, typeof name3 === 'string' && name3].filter((x) => x).join('.'))
            .get(func ?? name3 ?? (name2 as any));
    };
    typeSafeSchema.unsafeSchema = schema;
    return typeSafeSchema;
}
