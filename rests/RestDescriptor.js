/**
 * Created by clx on 2017/10/13.
 */
const MEDIA_TYPE = 'application/vnd.hotex.com+json',
    REASON_FORBIDDEN = "forbidden",
    REASON_IF_MATCH = 'if-match',
    REASON_NOTHING = 'nothing',
    REASON_CONCURRENT_CONFLICT = 'concurrent-conflict',
    REASON_NOT_FOUND = 'not-found';

const URL = require('../express/Url'),
    __ = require('underscore'),
    moment = require('moment'),
    logger = require('../app/Logger');

const __sendRes = (res, state, data) => {
    res.status(state)
    if (data) res.send(data)
    res.end()
}

const __attachHandler = function (router, method, context, urlPattern, restDesc) {
    return router[method](urlPattern, function (req, res) {
        return handlerMap[restDesc.type].handler(context, restDesc, req, res);
    });
};
const __getHandler = function (context, restDesc, req, res) {
    var query = Object.assign({}, req.query);
    var representation;
    return restDesc.handler(query)
        .then(function (data) {
            var self = URL.resolve(req, req.originalUrl);
            representation = {
                data: data,
                self: self
            };
            return context.getLinks(data, req);
        })
        .then(function (links) {
            representation.links = links;
            res.set('Content-Type', MEDIA_TYPE);
            return res.status(200).json(representation);
        })
        .catch(function (err) {
            console.error(err);
            return res.status(500).send(err);
        })
};
const __readHandler = function (context, restDesc, req, res) {
    var representation;
    return restDesc.handler(req, res)
        .then(function (data) {
            var self = URL.resolve(req, req.originalUrl);
            representation = {
                href: self
            };
            representation[context.getResourceId()] = data;
            res.set('ETag', data.__v);
            if (data.modifiedDate) res.set('Last-Modified', data.modifiedDate);
            return context.getLinks(data, req);
        })
        .then(function (links) {
            representation.links = links;
            res.set('Content-Type', MEDIA_TYPE);
            return res.status(200).json(representation);
        })
        .catch(function (err) {
            if (err.toLowerCase() === REASON_NOT_FOUND)
                return res.status(404).end();
            console.error(err);
            return res.status(500).send(err);
        })
};
const __queryHandler = function (context, restDesc, req, res) {
    var query = Object.assign({}, req.query);
    if (query.perpage) query.perpage = parseInt(query.perpage);
    if (query.page) query.page = parseInt(query.page);
    var representation;
    return restDesc.handler(query)
        .then(function (data) {
            var self = URL.resolve(req, req.originalUrl);
            representation = {
                collection: {
                    href: self,
                    perpage: data.perpage,
                    page: data.page,
                    total: data.total
                }
            };
            representation.collection.items = [];
            data.items.forEach(function (itemData) {
                var href = context.getTransitionUrl(restDesc.element, itemData, req);
                var copy = Object.assign({}, itemData);
                
                // TODO: 暂时保留id用于查询时可作为查询条件取值，以后应通过URL提供查询条件取值，例如查询指定料品的订单或采购单等
                // delete copy['id']
                var item = {
                    link: {
                        rel: restDesc.element,
                        href: href
                    },
                    data: copy
                };
                representation.collection.items.push(item);
            });
            return context.getLinks(data, req);
        })
        .then(function (links) {
            representation.links = links;
            res.set('Content-Type', MEDIA_TYPE);
            return res.status(200).json(representation);
        })
        .catch(function (err) {
            console.error(err);
            return res.status(500).send(err);
        })
};
const __deleteHandler = function (context, restDesc, req, res) {
    var id = req.params["id"];
    var etag = req.get("If-Match");
    var aPromis = etag ? restDesc.handler.condition(id, etag) :
        !restDesc.conditional ? Promise.resolve(true) : Promise.reject("Forbidden");
    return aPromis
        .then(function (data) {
            if (!data) return Promise.reject(REASON_IF_MATCH);
            return restDesc.handler.handle(id, etag);
        })
        .then(function () {
            return res.status(204).end();
        })
        .catch(function (reason) {
            if (reason.toLowerCase() === REASON_FORBIDDEN)
                return res.status(403).send("client must send a conditional request").end();
            if (reason.toLowerCase() === REASON_IF_MATCH)
                return res.status(412).end();
            if (reason.toLowerCase() === REASON_NOT_FOUND)
                return res.status(404).end();
            if (reason.toLowerCase() === REASON_CONCURRENT_CONFLICT)
                return res.status(304).end();
            if (restDesc.response && restDesc.response[reason]) {
                var msg = restDesc.response[reason].err ? restDesc.response[reason].err : reason;
                return res.status(restDesc.response[reason].code)
                    .send(msg)
                    .end();
            }
            console.error(reason);
            return res.status(500).send(reason);
        })
};

const __updateHandler = (context, restDesc, req, res) => {
    function __doResponse(data) {
        let {
            modifiedDate
        } = data || {}
        if (!modifiedDate) return Promise.reject(409)
        if (!moment(modifiedDate).isValid()) return Promise.reject(409)
        res.set('Last-Modified', modifiedDate)
        return __sendRes(res, 204)
    }

    function __doHandle() {
        if (!restDesc.handler || !restDesc.handler.handle || !__.isFunction(restDesc.handler.handle))
            return Promise.reject(501)
        let {
            conditional
        } = restDesc
        if (__.isUndefined(conditional)) conditional = true
        return conditional ? __conditionalHandle() : __handle()
    }

    function __conditionalHandle() {
        if (!restDesc.handler.condition || !__.isFunction(restDesc.handler.condition)) return Promise.reject(501)
        let ifUnmodifiedSince = req.get('If-Unmodified-Since')
        if (!ifUnmodifiedSince) return Promise.reject(428)

        let id = req.params["id"];
        return restDesc.handler.condition(id, ifUnmodifiedSince)
            .then(valid => {
                if (!valid) return Promise.reject(412)
                return restDesc.handler.handle(id, req.body);
            })
            .then(data => {
                return __doResponse(data)
            })
    }

    function __handle() {
        let id = req.params["id"];
        return restDesc.handler.handle(id, req.body)
            .then(data => {
                return __doResponse(data)
            })
    }

    return __doHandle()
        .catch(err => {
            if (__.isError(err)) err = 500
            return __sendRes(res, err)
        })
}

const __createHandler = function (context, restDesc, req, res) {
    var urlToCreatedResource, targetObject;
    return restDesc.handler(req.body)
        .then(function (data) {
            targetObject = data;
            urlToCreatedResource = context.getTransitionUrl(restDesc.target, data, req);
            return context.getLinks(data, req);
        })
        .then(function (links) {
            res.set('Content-Type', MEDIA_TYPE);
            res.set('Location', urlToCreatedResource);
            var representation = {
                href: urlToCreatedResource
            };
            representation[restDesc.target] = targetObject;
            if (links.length > 0) representation.links = links;
            return res.status(201).json(representation);
        })
        .catch(function (err) {
            console.error(err);
            return res.status(500).send(err);
        })
};
const __entryHandler = function (context, restDesc, req, res) {
    return context.getLinks(null, req)
        .then(function (links) {
            res.set('Content-Type', MEDIA_TYPE);
            return res.status(200).json({
                links: links
            });
        })
        .catch(function (err) {
            console.error(err);
            return res.status(500).send(err);
        })
};

const __uploadHandler = (context, restDesc, req, res) => {
    req.pipe(req.busboy)
    req.busboy.on('file', (fieldname, file, filename) => {
        logger.debug('Uploading: ' + filename)
        let writable = restDesc.handler()
        writable.on('finish', () => {
            return context.getLinks(null, req)
                .then(function (links) {
                    res.set('Content-Type', MEDIA_TYPE);
                    return res.status(200).json({
                        links: links
                    });
                })
                .catch(() => {
                    return res.status(500).end()
                })
        })
        file.pipe(writable)
    })
}

const handlerMap = {
    entry: {
        method: "get",
        handler: __entryHandler
    },
    get: {
        method: "get",
        handler: __getHandler
    },
    create: {
        method: "post",
        handler: __createHandler
    },
    update: {
        method: "put",
        handler: __updateHandler
    },
    delete: {
        method: "delete",
        handler: __deleteHandler
    },
    query: {
        method: "get",
        handler: __queryHandler
    },
    read: {
        method: "get",
        handler: __readHandler
    },
    upload: {
        method: "post",
        handler: __uploadHandler
    }
}

module.exports = {
    attach: function (router, currentResource, urlPattern, restDesc) {
        var type = restDesc.type.toLowerCase();
        return __attachHandler(router, handlerMap[type].method, currentResource, urlPattern, restDesc);
    }
}