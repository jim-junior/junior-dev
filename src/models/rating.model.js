const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const RatingSchema = new Schema({
    userId: {type: Schema.Types.ObjectId, ref: 'User'},
    category: String,
    item: String,
    value: Number
}, {
    timestamps: true
});

RatingSchema.index({userId: 1, category: 1, item: 1}, {unique: true});

RatingSchema.statics.categoryVote = function (category, item, value, userId) {
    return Rating.update({userId, category}, {item, value}, {upsert: true, setDefaultsOnInsert: true});
};

RatingSchema.statics.getCategoryVote = function (category, userId) {
    return Rating.findOne({userId, category});
};

RatingSchema.statics.rate = function (category, item, value, userId) {
    return Rating.update({userId, category, item}, {value}, {upsert: true, setDefaultsOnInsert: true});
};

const Rating = mongoose.model('Rating', RatingSchema);
module.exports = Rating;
