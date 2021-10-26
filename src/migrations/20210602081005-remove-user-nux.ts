import User from '../models/user.model';

/*
  Dropping nux from user schema
*/

module.exports = {
    async up() {
        return User.updateMany(
            {
                nux: {
                    $exists: true
                }
            },
            {
                $unset: {
                    nux: true
                }
            },
            {
                strict: false
            }
        );
    },

    async down() {},
};
