const session = require('express-session'),
    uuid = require('uuid-v4'),
    cookieParser = require('cookie-parser'),
    SocketIo = require('socket.io'),
    PassportSocketIo = require('passport.socketio'),
    KEY = 'express.sid',
    SESSION_SECRET = process.env.SESSION_SECRET || 'super secret for session',
    logger = require('../app/Logger'),
    MongoDBStore = require('connect-mongodb-session')(session);

const onAuthorizeSuccess = function(data, accept){
    logger.info('socket.io auth success');
    accept();
};

const onAuthorizeFail = function(data, message, error, accept){
    // error indicates whether the fail is due to an error or just a unauthorized client
    if(error){
        throw new Error(message);
    } else {
        logger.info(message);
        // the same accept-method as above in the success-callback
        accept(null, false);
    }
};

module.exports = function (maxAge) {
    var store = new MongoDBStore(
        {
            uri: process.env.MONGODB,
            collection: process.env.SESSION_COLLECTION || 'sessions'
        });

    // Catch errors
    store.on('error', function (error) {
        logger.error('session store error:' + JSON.stringify(error));
    });

    return {
        attachTo: function (app) {
            // Use express session support since OAuth2orize requires it
            app.use(session({
                genid: function () {
                    return uuid();
                },
                key: KEY,
                cookie: {
                    maxAge: maxAge || 1000 * 60 * 60 * 24,
                    secure: process.env.NODE_ENV === 'production'
                },
                secret: SESSION_SECRET,
                saveUninitialized: true,
                resave: true,
                store: store
            }));
        },
        authByServer: function (server) {
            logger.info('begin auth by server .......');
            const io = SocketIo(server);
            io.use(PassportSocketIo.authorize({
                cookieParser: cookieParser,
                key: KEY,
                secret: SESSION_SECRET,
                store: store,
                success: onAuthorizeSuccess,
                fail: onAuthorizeFail
            }))
        }
    };
};