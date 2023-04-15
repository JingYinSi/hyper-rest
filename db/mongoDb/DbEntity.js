const __ = require('underscore'),
    {each, map, pick, findIndex, initial, extend, last, isString, isUndefined} = __,
    createSubdocConfig = require('./CreateSubdocConfig')

function __getUpdatedAtNameFromSchema(schema) {
    return schema.schema.$timestamps.updatedAt
}

const __genWhere = (subDocId, path) => {
    let paths = isString(path) ? path.split('.') : path
    let whereClouse
    for(i=0;i<paths.length;i++) {
        if (i == 0) {
            whereClouse = {}
            whereClouse[paths[paths.length -i -1]] = {
                $elemMatch: {_id: subDocId}
            }
        } else {
            up = {}
            up[paths[paths.length -i -1]] = {
                $elemMatch: whereClouse
            }
            whereClouse = up
        }
    }
    return whereClouse
}

const __findSubDocFromParent = (doc, subDocId, path, filter) => {
    let paths = isString(path) ? path.split('.') : path
    let indexes = [paths.length]
    __findIndex = (subDoc, from) => {
        indexes[from] = findIndex(subDoc[paths[from]], el => {
            if (from + 1 == paths.length) {
                e = el._id == subDocId
                return e
            }
            __findIndex(el, from + 1)
            e = indexes[from + 1] >= 0
            return e
        })
    }
    __findIndex(doc, 0)

    __getSub = (doc, lev, pathDoc) => {
        let sd = doc[paths[lev]][indexes[lev]]
        if (lev == paths.length - 1) {
            const jsonSubDoc = sd.toJSON()
            extend(pathDoc, filter ? filter(jsonSubDoc) : jsonSubDoc)
            return sd
        } else {
            pathDoc[paths[lev]] = sd.id
        }
        return __getSub(sd, lev + 1, pathDoc)
    }

    let pathDoc = {}
    let subDoc = __getSub(doc, 0, pathDoc)
    return {pathDoc, subDoc}
}

class Entity {
    constructor(config) {
        this.__config = config
        this.__subdoc = createSubdocConfig(config.subdoc)
    }

    // TODO: write test case
    create(data) {
        const schema = this.__config.schema,
            projection = this.__config.projection
        return new schema(data).save()
            .then(doc => {
                return schema.findById(doc.id, projection)
            })
            .then(doc => {
                return doc.toJSON()
            })
    }

    createSubDoc(parentId, path, data) {
        const subPath = isString(path) ? path.split('.') : path
        const filter = this.__subdoc.filterNew
        let row, subDoc
        const parentPath = initial(subPath)
        const subFld = last(subPath)
        let findParent = parentPath.length == 0 ? this.__config.schema.findById(parentId) : this.findBySubDocId(parentId, parentPath)
        return findParent
            .then(doc => {
                if (!doc) return Promise.reject()
                subDoc = parentPath.length == 0 ? doc : __findSubDocFromParent(doc, parentId, parentPath).subDoc
                row = subDoc[subFld].push(data)
                return doc.save()
                    .then(() => {
                        doc = filter(subDoc[subFld][row - 1].toJSON())
                        return doc
                    })
            })
    }

    findById(id) {
        let __config = this.__config

        return __config.schema.findById(id, __config.projection)
            .then(doc => {
                let result
                if (doc) result = doc.toJSON()
                return result
            })
    }

    findBySubDocId(subDocId, paths) {
        const schema = this.__config.schema
        const wh = __genWhere(subDocId, paths)
        if(!wh) return Promise.resolve()

        return schema.findOne(wh)
    }

    findSubDocById(subDocId, path) {
        const __filter = this.__subdoc.filter
        let filter = (obj) => __filter(path, obj)
        const paths = isString(path) ? path.split('.') : path
        const schema = this.__config.schema
        return this.findBySubDocId(subDocId, paths)
            .then(doc => {
                if (!doc) return
                let pathDoc = __findSubDocFromParent(doc, subDocId, paths, filter).pathDoc
                let {id, __v, updatedAt} = doc.toJSON()
                pathDoc[schema.modelName] = id
                return {__v, updatedAt, ...pathDoc}
            })
    }

    update(data) {
        let __config = this.__config
        return __config.schema.findById(data.id)
            .then(doc => {
                if (doc && doc.__v >= 0 && doc.__v === data.__v) {
                    __.each(__config.updatables, fld => {
                        if (__.isString(data[fld]) && data[fld].length === 0) doc[fld] = undefined
                        else doc[fld] = data[fld]
                    })
                    if (__config.setValues) __config.setValues(doc, data)
                    return doc.save()
                        .then(doc => {
                            return doc.toJSON()
                        })
                }
            })
    }

    updateSubDoc(path, data) {
        return this.findBySubDocId(data.id, path)
            .then(doc => {
                if (!doc || !isUndefined(data.__v) && data.__v != doc.__v) return
                let subDoc = __findSubDocFromParent(doc, data.id, path).subDoc
                each(data.toUpdate, (val, fld)  => {
                    if (__.isString(val) && val.length === 0) subDoc[fld] = undefined
                    else subDoc[fld] = val
                })
                return doc.save()
                    .then(() => {
                        return subDoc.toJSON()
                    })
            })
    }

    updateManySubDoc(path, data, subIds) {
        return this.findBySubDocId(data.id, path)
            .then(doc => {
                if (!doc || !isUndefined(data.__v) && data.__v != doc.__v) return

                let subDoc
                subIds.forEach(subId => {
                    subDoc = __findSubDocFromParent(doc, subId, path).subDoc
                    each(data.toUpdate, (val, fld)  => {
                        if (__.isString(val) && val.length === 0) subDoc[fld] = undefined
                        else subDoc[fld] = val
                    })
                })

                return doc.save()
                    .then(() => {
                        return subDoc.toJSON()
                    })
            })
    }


    ifNoneMatch(id, version) {
        return this.ifMatch(id, version)
            .then((data) => {
                return !data
            })
    }

    ifModifiedSince(id, version) {
        return this.ifUnmodifiedSince(id, version)
            .then((data) => {
                return !data
            })
    }

    ifMatch(id, version) {
        const func = __.isObject(id) ? 'findOne' : 'findById'
        return  this.__config.schema[func](id)
            .then(doc => {
                if (doc) {
                    return doc.__v.toString() === version
                }
                return false
            })
    }

    ifUnmodifiedSince(id, version) {
        const updatedAtName = __getUpdatedAtNameFromSchema(this.__config.schema)
        const func = __.isObject(id) ? 'findOne' : 'findById'
        return  this.__config.schema[func](id)
            .then(doc => {
                if (doc) {
                    return doc[updatedAtName].toUTCString() === version
                }
                return false
            })
    }

    search(cond, text) {
        const config = this.__config
        cond = cond || {}
        let query = cond

        if (text && text.length > 0) {
            let filters = __.map(config.searchables, fld => {
                let filter = {}
                filter[fld] = {
                    $regex: text,
                    $options: 'si'
                }
                return filter
            })
            query = {
                $and: [cond, {
                    $or: filters
                }]
            }
        }

        let sort = config.sort
        if (!sort) {
            sort = {}
            const updatedAtName = __getUpdatedAtNameFromSchema(config.schema)
            sort[updatedAtName] = -1
        }
        const limit = config.queryListLinesLimit || process.env.QUERY_LIST_LINES_LIMIT || 20
        const projection = config.listable
        return config.schema.find(query, projection).sort(sort).limit(limit * 1)
            .then(data => {
                return __.map(data, item => {
                    return item.toJSON()
                })
            })
    }

    remove(id) {
        return this.__config.schema.deleteOne({
            _id: id
        })
            .then((data) => {
                if (data.n === 0 && data.deletedCount === 0) return
                return (data.deletedCount === 1 && data.ok === 1)
            })
    }

    removeSubDoc(subDocId, paths) {
        return this.findBySubDocId(subDocId, paths)
            .then(parent => {
                if (!parent) return
                const doc = __findSubDocFromParent(parent, subDocId, paths)
                doc.subDoc.remove()
                return parent.save()
                    .then(() => {
                        return true
                    })
            })
    }

    listSubs(parentId, path) {
        const __filter = this.__subdoc.filterFromList
        let filter = (obj) => __filter(path, obj)
        let paths = isString(path) ? path.split('.') : path
        const parentPath = initial(paths)
        const subFld = last(paths)
        let findParent = parentPath.length == 0 ? this.__config.schema.findById(parentId) : this.findBySubDocId(parentId, parentPath)
        return findParent
            .then(doc => {
                if (!doc) return []
                let subDoc = parentPath.length == 0 ? doc : __findSubDocFromParent(doc, parentId, parentPath).subDoc
                subDoc = subDoc.toJSON()
                return filter(subDoc[subFld] || [])
            })
    }
}

const __create = (config, addIn) => {
    const entity = new Entity(config)
    const obj = {
        create(data) {
            return entity.create(data)
        },

        findById(id, projection) {
            return entity.findById(id, projection)
        },

        findBySubDocId(subDocId, paths) {
            return entity.findBySubDocId(subDocId, paths)
        },

        findSubDocById(id, path) {
            return entity.findSubDocById(id, path)
        },

        search(cond, text, sort) {
            return entity.search(cond, text, sort)
        },

        ifMatch(id, version) {
            return entity.ifMatch(id, version)
        },

        ifUnmodifiedSince(id, version) {
            return entity.ifUnmodifiedSince(id, version)
        },

        update(data) {
            return entity.update(data)
        },

        updateSubDoc(path, data) {
            return entity.updateSubDoc(path, data)
        },

        updateManySubDoc(path, data, subIds) {
            return entity.updateManySubDoc(path, data, subIds)
        },

        remove(id) {
            return entity.remove(id)
        },

        removeSubDoc(id, path) {
            return entity.removeSubDoc(id, path)
        },

        listSubs(parentId, path) {
            return entity.listSubs(parentId, path)
        },

        createSubDoc(parentId, path, data) {
            return entity.createSubDoc(parentId, path, data)
        },

        ...addIn
    }

    return obj
}

module.exports = __create