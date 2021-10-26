const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const serializeError = require('serialize-error');

const BuildErrorSchema = new Schema({
    userId: {type: Schema.Types.ObjectId, ref: 'User'},
    projectId: {type: Schema.Types.ObjectId, ref: 'Project'},
    error: {
        type: Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

BuildErrorSchema.statics.saveError = function (error, projectId, userId) {
    return new BuildError({error: serializeError(error), projectId, userId}).save();
};

const BuildError = mongoose.model('BuildError', BuildErrorSchema);
module.exports = BuildError;
