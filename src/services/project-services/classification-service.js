const _ = require('lodash');
const mongoose = require('mongoose');
const logger = require('../logger');
const ClassificationRuleset = require('../../models/classification-ruleset.model');
const Project = require('../../models/project.model').default;
const analyticsDb = require('../analytics/analytics-db');

async function classifyAndUpdateAllProjects() {
    const projectIds = await Project.findNonDraftProjectIds();
    const rulesets = await rulesetsOrDefault();
    let writes = [];

    for await (const result of classifyProjects(projectIds, rulesets)) {
        const classifications = result.classifications.map(c => ([
            c.ruleset,
            c
        ]));
        writes.push({
            updateOne: {
                filter: { _id: result.projectId },
                update: {
                    $set: {
                        classifications: Object.fromEntries(classifications)
                    }
                },
                timestamps: false
            }
        });

        if (writes.length >= 1000) {
            await Project.bulkWrite(writes, { ordered: false });
            writes = [];
        }
    }

    if (writes.length > 0) {
        await Project.bulkWrite(writes, { ordered: false });
    }
}

async function* classifyProjects(projectIds, rulesets = null) {
    rulesets = await rulesetsOrDefault(rulesets);
    rulesets.map(ruleset => ruleset.setUniqueAtomicPredicateKeys());

    await Promise.all(rulesets.map(r => r.validate()));

    for (const ids of _.chunk(projectIds, 1000)) {
        yield* await classifyProjectsInParallel(ids, rulesets);
    }
}

async function rulesetsOrDefault(rulesets) {
    if (!rulesets) {
        rulesets = await ClassificationRuleset.active();
    }
    return rulesets;
}

async function classifyProjectsInParallel(projectIds, rulesets) {
    const rulesetsPredicatesData = Object.fromEntries(await Promise.all(
        rulesets.map(async (ruleset, rulesetIdx) => ([
            rulesetIdx,
            await loadDataForProjects(projectIds, ruleset)
        ]))
    ));
    return projectIds.map((projectId) => ({
        projectId,
        classifications: rulesets.map((ruleset, rulesetIdx) => {
            return {
                ruleset: ruleset.name,
                ...classifyProjectWithData(projectId, ruleset, rulesetsPredicatesData[rulesetIdx])
            };
        })
    }));
}

function classifyProjectWithData(projectId, ruleset, predicatesData) {
    let currentRuleIdx = 0;
    const output = {
        group: null,
        classifyingRule: null,
        classificationLog: [],
    };

    loop:
    while (ruleset.rules[currentRuleIdx]) {
        const { matched, matchMetadata } = match(ruleset.rules[currentRuleIdx].predicate, predicatesData, projectId);
        output.classificationLog.push({
            ruleIdx: currentRuleIdx,
            matched,
            matchMetadata,
            ...(matched ? { action: ruleset.rules[currentRuleIdx].action } : {})
        });
        if (matched) {
            switch (ruleset.rules[currentRuleIdx].action) {
            case 'stop': {
                break loop;
            }

            case 'classify':
            case 'tentatively-classify': {
                output.group = ruleset.rules[currentRuleIdx].group;
                output.classifyingRule = currentRuleIdx;
                if (ruleset.rules[currentRuleIdx].action === 'classify') {
                    break loop;
                }
                break;
            }

            default: {
                throw new Error(`Invalid classification action: ${ruleset.rules[currentRuleIdx].action}`);
            }
            }
        }
        currentRuleIdx += 1; // continue evaluation
    }
    return output;
}

async function loadMongoDataForProjects(model, baseMatch, projectIdField, projectIds, predicate) {
    const rows = await model
        .aggregate()
        .match({
            [projectIdField]: {
                $in: projectIds
            },
            ...baseMatch,
            ...JSON.parse(predicate.match || '{}')
        })
        .project({
            _id: 0,
            projectId: `$${projectIdField}`,
            value: predicate.selector || '⊤'
        })
        .exec();
    return Object.fromEntries(rows.map(({ projectId, value }) => ([
        projectId.toString(),
        value
    ])));
}

async function loadDataForProjects(projectIds, ruleset) {
    return Object.fromEntries(await Promise.all(
        ruleset.listAtomicPredicates().map(async (predicate) => {
            switch (predicate.type) {
            case 'project': {
                return [
                    predicate.key,
                    await loadMongoDataForProjects(
                        Project,
                        {},
                        '_id',
                        projectIds,
                        predicate
                    )
                ];
            }

            case 'analytics': {
                if (!analyticsDb.pool) {
                    return [
                        predicate.key,
                        {}
                    ];
                }
                const resultset = await analyticsDb.pool.query({
                    text: predicate.query,
                    values: [
                        projectIds.map(id => id.toString())
                    ],
                    rowMode: 'array'
                });
                return [
                    predicate.key,
                    Object.fromEntries(resultset.rows.map(([ projectId, value ]) => ([
                        projectId,
                        value
                    ])))
                ];
            }

            default: {
                throw new Error(`Invalid atomic predicate type: ${predicate.type}`);
            }
            }
        })
    ));
}

function match(predicate, predicatesData, projectId) {
    switch (predicate.__t) {
    case 'AtomicPredicate': {
        const data = predicatesData[predicate.key][projectId.toString()];
        return {
            matched: atomicPredicateMatch(predicate, data),
            matchMetadata: data
        };
    }
    case 'SomeOfPredicate': {
        const minimumRequired = typeof predicate.minimumRequired === 'number' ?
            predicate.minimumRequired :
            predicate.items.length;
        const matchedItems = predicate.items.map(p => match(p, predicatesData, projectId));
        const matchedItemsCount = matchedItems.filter(r => r.matched).length;
        return {
            matched: matchedItemsCount >= minimumRequired,
            matchMetadata: matchedItems
        };
    }
    default: {
        throw new Error(`Invalid predicate type: ${predicate.type}`);
    }
    }
}

function atomicPredicateMatch(predicate, data) {
    switch (predicate.operator) {
    case 'exists': {
        return !!data;
    }
    case 'equals': {
        if (typeof predicate.value === 'number') {
            return Math.abs(Number(data) - predicate.value) < 1e-5; // good enough difference?
        } else if (typeof predicate.value === 'string') {
            return (data || '').toString() === predicate.value;
        } else {
            return data === predicate.value;
        }
    }
    case 'does-not-equal': {
        if (typeof predicate.value === 'number') {
            return Math.abs(Number(data) - predicate.value) >= 1e-5; // good enough difference?
        } else if (typeof predicate.value === 'string') {
            return (data || '').toString() !== predicate.value;
        } else {
            return data !== predicate.value;
        }
    }
    case 'regexp-test': {
        return new RegExp(predicate.value, 'i').test(data);
    }
    case 'greater-than': {
        if (typeof predicate.value === 'number') {
            return Number(data) > predicate.value;
        } else {
            return new Error('Invalid comparison with non-numeric value');
        }
    }
    case 'greater-than-or-equals-to': {
        if (typeof predicate.value === 'number') {
            return Number(data) >= predicate.value;
        } else {
            return new Error('Invalid comparison with non-numeric value');
        }
    }
    case 'lesser-than': {
        if (typeof predicate.value === 'number') {
            return Number(data) < predicate.value;
        } else {
            return new Error('Invalid comparison with non-numeric value');
        }
    }
    case 'lesser-than-or-equals-to': {
        if (typeof predicate.value === 'number') {
            return Number(data) <= predicate.value;
        } else {
            return new Error('Invalid comparison with non-numeric value');
        }
    }
    case 'older-than': {
        return (new Date() - new Date(data)) > predicate.value;
    }
    case 'younger-than': {
        return (new Date() - new Date(data)) < predicate.value;
    }
    default: {
        throw new Error(`Invalid match operator: ${predicate.operator}`);
    }
    }
}

module.exports = {
    classifyProjects,
    classifyAndUpdateAllProjects
};
