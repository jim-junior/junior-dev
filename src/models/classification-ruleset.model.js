const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const _ = require('lodash');
const uuid = require('uuid/v4');

const PredicateSchema = new Schema({}, { _id: true });

const AtomicPredicateSchema = new Schema({
    key: { type: String },
    type: {
        type: String,
        enum: [
            'analytics',
            'project',
            'project.snapshot', // unused
        ],
        required: true
    },
    operator: {
        type: String,
        enum: [
            'exists',
            'equals',
            'does-not-equal',
            'regexp-test',
            'greater-than',
            'greater-than-or-equals-to',
            'lesser-than',
            'lesser-than-or-equals-to',
            'older-than',
            'younger-than'
        ],
        required: true
    },
    value: {
        type: Schema.Types.Mixed,
        required() {
            return this.operator !== 'exists';
        }
    },
    query: {
        type: String,
        required() {
            return ['analytics'].includes(this.type);
        }
    },
    match: { type: Schema.Types.String },
    selector: { type: Schema.Types.String }
});

const SomeOfPredicateSchema = new Schema({
    minimumRequired: {
        type: Number
    },
    items: [PredicateSchema]
});

SomeOfPredicateSchema.path('items').discriminator('AtomicPredicate', AtomicPredicateSchema);
SomeOfPredicateSchema.path('items').discriminator('SomeOfPredicate', SomeOfPredicateSchema);

const RuleSchema = new Schema({
    predicate: {
        type: PredicateSchema,
        required: true
    },
    action: {
        type: String,
        enum: [
            'stop',
            'classify',
            'tentatively-classify'
        ],
        required: true
    },
    group: {
        type: String,
        required() {
            return ['classify', 'tentatively-classify'].includes(this.action);
        }
    }
});

RuleSchema.path('predicate').discriminator('AtomicPredicate', AtomicPredicateSchema);
RuleSchema.path('predicate').discriminator('SomeOfPredicate', SomeOfPredicateSchema);

const ClassificationRulesetSchema = new Schema({
    name: { type: String, required: true },
    draft: { type: Boolean, default: false },
    rules: { type: [RuleSchema], required: true }
}, {
    timestamps: true
});

ClassificationRulesetSchema.index({ name: 1 }, { unique: true });
ClassificationRulesetSchema.index({ draft: 1 });

function collectAtomicPredicates(predicate) {
    switch (predicate.__t) {
    case 'AtomicPredicate': {
        return [predicate];
    }
    case 'SomeOfPredicate': {
        return predicate.items.map(p => collectAtomicPredicates(p)).flat();
    }
    default: {
        throw new Error(`Invalid predicate type: ${predicate.type}`);
    }
    }
}

ClassificationRulesetSchema.methods.listAtomicPredicates = function() {
    return this.rules.map(rule => collectAtomicPredicates(rule.predicate)).flat();
};

ClassificationRulesetSchema.methods.setUniqueAtomicPredicateKeys = async function() {
    for (const predicate of this.listAtomicPredicates()) {
        if (typeof predicate.key !== 'string') {
            predicate.key = uuid();
        }
    }
};

ClassificationRulesetSchema.statics.active = function() {
    return ClassificationRuleset.find({ draft: false });
};

const ClassificationRuleset = mongoose.model('ClassificationRuleset', ClassificationRulesetSchema);
module.exports = ClassificationRuleset;
