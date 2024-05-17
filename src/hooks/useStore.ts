import { useEffect, useMemo, useState } from "react";
import { InstancePresenceRecordType, SerializedSchema, TLAnyShapeUtilConstructor, TLInstancePresence, TLRecord, TLStoreWithStatus, computed, createPresenceStateDerivation, createTLStore, defaultShapeUtils, defaultUserPreferences, getUserPreferences, react, setUserPreferences } from "tldraw";
import { YKeyValue } from "y-utility/y-keyvalue";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

export function useStore({ roomId = 'sample', hostUrl= 'ws://localhost:1234', shapeUtils = [] }: Partial<{
    roomId: string;
    hostUrl: string;
    shapeUtils: TLAnyShapeUtilConstructor[]
}>){
    const [store] = useState(() => {
        const store = createTLStore({
            shapeUtils: [...defaultShapeUtils, ...shapeUtils],
        })
        return store;
    })

    const [storeWithStatus, setStoreWithStatus] = useState<TLStoreWithStatus>({
        status: 'loading'
    })
    // avoidn rerenders
    const { yDoc, yStore, meta, room } = useMemo(() => {
        const yDoc = new Y.Doc({ gc: true });
        const yArr = yDoc.getArray<{key: string; val: TLRecord }>(`tl_${roomId}`)
        const yStore = new YKeyValue(yArr);
        const meta = yDoc.getMap<SerializedSchema>('meta');

        return {
            yDoc, yStore, meta, room: new WebsocketProvider(hostUrl, roomId, yDoc, { connect: true })
        }
    }, [hostUrl, roomId])


    useEffect(() => {
        setStoreWithStatus({ status: 'loading' })
        const unsubs: (() => void)[] = []
        function handleSync() {
            //For document
            //Store changes to yjs doc
            unsubs.push(
                store.listen(
                    function syncStoreChangesToYjsDoc({ changes }){
                        yDoc.transact(() => {
                            Object.values(changes.added).forEach((record) => {
                                yStore.set(record.id, record);
                            })

                            Object.values(changes.updated).forEach(([_, record]) => {
                                yStore.set(record.id, record);
                            })

                            Object.values(changes.removed).forEach((record) => {
                                yStore.delete(record.id);
                            })
                        })
                    },
                    {source: "user", scope: "document"}
                )
            )

            //Yjs doc to store
            const handleChange = (
                changes: Map<string, {action: 'delete'; oldValue: TLRecord } | {action: 'update'; oldValue: TLRecord; newValue: TLRecord } | { action: 'add'; newValue: TLRecord }
                >, transaction: Y.Transaction,
            ) => {
                if(transaction.local) return

                const remove: TLRecord['id'][] = []
                const put: TLRecord[]  = []
                //changes.forEach((value, key))
                changes.forEach((change, id) => {
                    switch (change.action){
                        case 'add':
                        case 'update': {
                            const record = yStore.get(id)!
                            
                            put.push(record);
                            break;
                        }
                        case 'delete': {
                            //remove is an array of type TLRecord['id'], id is inferred as having the type TLRecord['id']
                            remove.push(id as TLRecord['id'])
                            break
                        }
                    }
                })

                // put/ remove the records in the store
                store.mergeRemoteChanges(() => {
                    if(remove.length) store.remove(remove)
                    if(put.length) store.put(put)
                })
            }

            yStore.on('change', handleChange)
            //unregister the event listener
            unsubs.push(() => yStore.off('change', handleChange));

            //for awareness
            const yClientId = room.awareness.clientID.toString()
            setUserPreferences({ id: yClientId })
            const userPrefs = computed<{
                id: string;
                color: string;
                name: string
            }>('userPreferences', () => {
                const user = getUserPreferences()

                return {
                    id: user.id,
                    color: user.color ?? defaultUserPreferences.color,
                    name: user.name ?? defaultUserPreferences.name,
                }
            })

            const presenceId = InstancePresenceRecordType.createId(yClientId)
            const presenceDerivation = createPresenceStateDerivation(
                userPrefs,
                presenceId
            )(store)
            //initial presence from derivation's current value
            room.awareness.setLocalStateField('presence', presenceDerivation.get());

            // When the derivation changes, sync presence to yjs awareness

            unsubs.push(
                react('when presence changes', () => {
                    const presence = presenceDerivation.get();
                    requestAnimationFrame(() => {
                        room.awareness.setLocalStateField('presence', presence);
                    })
                })
            )

            // yjs awareness changes to store

            const handleUpdate = (update: {
                added: number[];
                updated: number[];
                removed: number[]
            }) => {
                const states = room.awareness.getStates() as Map<number, { presence: TLInstancePresence}>

                const remove: TLInstancePresence['id'][] = []
                const put: TLInstancePresence[] = []

                for(const clientId of update.added){
                    const state = states.get(clientId)
                    if(state?.presence && state.presence.id !== presenceId){
                        put.push(state.presence);
                    }
                }

                for(const clientId of update.updated){
                    const state = states.get(clientId);
                    if(state?.presence && state.presence.id !== presenceId){
                        put.push(state.presence);
                    }
                }

                for(const clientId of update.removed){
                    remove.push(InstancePresenceRecordType.createId(clientId.toString()));
                }

                //merge changes to store
                store.mergeRemoteChanges(() => {
                    if(remove.length) store.remove(remove)
                    if(put.length) store.put(put)
                })
            }

            const handleMetaUpdate = () => {
                const theirSchema = meta.get('schema');
                if(!theirSchema){
                    throw new Error('No schema found');
                }

                const newMigrations = store.schema.getMigrationsSince(theirSchema);
                if(!newMigrations.ok || newMigrations.value.length > 0){
                    window.alert('Please refresh the page, schema is updated');
                    yDoc.destroy()
                }
            }

            meta.observe(handleMetaUpdate);
            //remove listener
            unsubs.push(() => meta.unobserve(handleMetaUpdate))

            room.awareness.on('update', handleUpdate);
            unsubs.push(() => room.awareness.off('update', handleUpdate));

            // Initialize the store with yjs doc records or if the doc is empty, initialize the yjs doc with the default store records

            if(yStore.yarray.length){
                //Replace store records with the yjs doc records
                const ourSchema = store.schema.serialize();
                const theirSchema = meta.get('schema')
                if(!theirSchema){
                    throw new Error('No schema found');
                }

                const records = yStore.yarray.toJSON().map(({ val }) => val)

                const migrationResult = store.schema.migrateStoreSnapshot({
                    schema: theirSchema,
                    store: Object.fromEntries(
                        records.map((record) => [record.id, record])
                    )
                })

                if(migrationResult.type === 'error'){
                    //refresh the page as schema is new
                    console.error(migrationResult.reason);
                    window.alert('The schema has been updated. Please refresh the page');
                    return
                }

                yDoc.transact(() => {
                    //delete records, not present in yjs doc
                    for(const rec of records){
                        if(!migrationResult.value[rec.id]){
                            yStore.delete(rec.id);
                        }
                    }
                    for(const r of Object.values(migrationResult.value) as TLRecord[]){
                        yStore.set(r.id, r)
                    }
                    meta.set('schema', ourSchema)
                })

                store.loadSnapshot({
                    store: migrationResult.value,
                    schema: ourSchema
                });
            }else{
                // Create initial store records and sync them to the yjs doc
                yDoc.transact(() => {
                    for(const rec of store.allRecords()){
                        yStore.set(rec.id, rec);
                    }
                    meta.set('schema', store.schema.serialize())
                })
            }

            setStoreWithStatus({
                store,
                status: 'synced-remote',
                connectionStatus: 'online'
            })

        }

            let hasConnectedBefore = false;

            function handleStatusChange({
                status
            }: {
                status: 'disconnected' | 'connected'
            }){
                if(status === 'disconnected'){
                    setStoreWithStatus({
                        store, 
                        status: 'synced-remote',
                        connectionStatus: 'offline'
                    })
                    return
                }

                room.off('synced', handleSync)
                if(status === 'connected'){
                    if(hasConnectedBefore) return
                    hasConnectedBefore = true;
                    room.on('synced', handleSync);
                    unsubs.push(() => room.off('synced', handleSync))
                }
            }

            room.on('status', handleStatusChange)
            unsubs.push(() => room.off('status', handleStatusChange));
            return () => {
                unsubs.forEach((fn) => fn());
                unsubs.length = 0;
            }
        
        
    }, [room, yDoc, store, yStore, meta])

    return storeWithStatus
    
}