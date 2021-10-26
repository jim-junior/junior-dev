const express = require('express');
const router = express.Router();
const joboxRoutes = require('./routes/jobox.routes');
const joboxService = require('../services/jobox-service/jobox-service');

function joboxAuth(req, res, next) {
    if (!req.headers.authorization) {
        return res.status(403).json({error: 'Invalid credentials'});
    }
    let authHeader = req.headers.authorization.split(' ');
    if (authHeader[0].toLowerCase() === 'bearer' && authHeader[1] === 'a13fe81fb1a0d5292da9dad92cb862d804a03dd9') {
        return next();
    }

    return res.status(403).json({message: 'Invalid credentials'});
}

// Routes used by Jobox App
router.get('/:joboxId', joboxAuth, joboxRoutes.get);
router.post('/:joboxId', joboxAuth, joboxRoutes.create);
router.put('/:joboxId', joboxAuth, joboxRoutes.update);
router.put('/republish/:joboxId', joboxAuth, joboxRoutes.publish);
router.delete('/:joboxId', joboxAuth, joboxRoutes.delete);

// Routes used by Jobox public sites admin page ie https://bc.jobox.com/rob-15/admin
router.get('/admin/:joboxId', joboxService.joboxAuthAdmin, joboxRoutes.adminGet);
router.put('/admin/:joboxId', joboxService.joboxAuthAdmin, joboxRoutes.adminUpdate);

module.exports = router;
