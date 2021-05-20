const __ = require('underscore'),
{findIndex} = __

function __getUpdatedAtNameFromSchema(schema) {
    return schema.schema.$timestamps.updatedAt
}

function __getSubDocPathNames(schema, sub) {
    const paths = schema.schema.paths[sub].schema.paths
    const names = []
    __.each(paths, (val, key) => {
        if(key !== '_id') names.push(key)
    })
    return names
}

const __genWhere = (subDocId, paths) => {
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

const __findSubDocFromParent = (doc, subDocId, paths) => {
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
		sd = doc[paths[lev]][indexes[lev]]
		if (lev == paths.length - 1) {
            pathDoc[paths[lev]] = sd.toJSON()
            return sd
        } else {
            pathDoc[paths[lev]] = sd.id
        }
		return __getSub(sd, lev + 1, pathDoc)
	}

    pathDoc = {}
	subDoc = __getSub(doc, 0, pathDoc)
    return {pathDoc, subDoc}
}

const __deleteSubDocById = (schema, subDocId, paths) => {
	wh = __genWhere(subDocId, paths)
	return schema.findOne(wh)
		.then(parent => {
			if (!parent) return
			doc = __findSubDocFromParent(parent, subDocId, paths)
			doc.remove()
			return parent.save()
		})
}

class Entity {
    constructor(config) {
        this.__config = config
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

    createSubDoc(id, sub, data) {
        let row
        return this.__config.schema.findById(id)
            .then(doc => {
                if (!doc) return
                row = doc[sub].push(data)
                return doc.save()
                    .then(doc => {
                        doc = doc.toJSON()
                        const data = {
                            ...doc[sub][row - 1],
                            __v: doc.__v
                        }
                        const modelName = this.__config.schema.modelName
                        const updatedAtName = __getUpdatedAtNameFromSchema(this.__config.schema)
                        data[modelName] = doc.id
                        data[updatedAtName] = doc[updatedAtName]
                        return data
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

    findSubDocById(subDocId, paths) {
        const schema = this.__config.schema
        const wh = __genWhere(subDocId, paths)
        if(!wh) return Promise.resolve()
        
        return schema.findOne(wh)
            .then(doc => {
                if (!doc) return
                pathDoc = __findSubDocFromParent(doc, subDocId, paths).pathDoc
                let {id, __v, updatedAt} = doc.toJSON()
                subDoc = {__v, updatedAt, ...pathDoc}
                subDoc[schema.modelName] = id
                return subDoc
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

    updateSubDoc(sub, data) {
        const config = this.__config,
        schema = config.schema,
        id = data[schema.modelName]
        return schema.findById(id)
            .then(doc => {
                if (!doc || doc.__v !== data.__v) return
                let subdoc = doc[sub].id(data.id)
                if (!subdoc) return
                let subUpdatables = config.subUpdatables || {}
                subUpdatables = subUpdatables[sub] || __getSubDocPathNames(schema, sub)
                __.each(subUpdatables, fld => {
                    if (__.isString(data[fld]) && data[fld].length === 0) subdoc[fld] = undefined
                    else subdoc[fld] = data[fld]
                })
                return doc.save()
                    .then(doc => {
                        if (doc) return subdoc.toJSON()
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
        const schema = this.__config.schema
        const wh = __genWhere(subDocId, paths)
        return schema.findOne(wh)
            .then(parent => {
                if (!parent) return
                const doc = __findSubDocFromParent(parent, subDocId, paths)
                doc.subDoc.remove()
                return parent.save()
            })
    }

    listSubs(id, subFld) {
        return this.__config.schema.findById(id)
            .then(doc => {
                if (doc) {
                    const subs = doc[subFld]
                    if (subs) {
                        return __.map(subs, item => {
                            return item.toJSON()
                        })
                    }
                }
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

        updateSubDoc(sub, data) {
            return entity.updateSubDoc(sub, data)
        },

        remove(id) {
            return entity.remove(id)
        },

        removeSubDoc(id, path) {
            return entity.removeSubDoc(id, path)
        },

        listSubs(id, subFld) {
            return entity.listSubs(id, subFld)
        },

        createSubDoc(id, sub, data) {
            return entity.createSubDoc(id, sub, data)
        },

        ...addIn
    }

    return obj
}

module.exports = __create