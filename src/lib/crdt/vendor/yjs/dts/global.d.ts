declare type GC = import('./structs/GC.js').GC
declare type Item = import('./structs/Item.js').Item
declare type Skip = import('./structs/Skip.js').Skip
declare type IdRange = import('./utils/ids.js').IdRange
declare type IdSet = import('./utils/ids.js').IdSet
declare type IdMap<Attrs> = import('./utils/ids.js').IdMap<Attrs>
declare type AttrRanges<Attrs = any> = import('./utils/ids.js').AttrRanges<Attrs>
declare type AttrRange<Attrs = any> = import('./utils/ids.js').AttrRange<Attrs>
declare type ContentAttribute<V=any> = import('./utils/ids.js').ContentAttribute<V>
declare type ContentIds = import('./utils/ids.js').ContentIds
declare type ContentMap= import('./utils/ids.js').ContentMap


declare type BlockSet = import('./utils/BlockSet.js').BlockSet
declare type UpdateDecoderV1 = import('./utils/UpdateDecoder.js').UpdateDecoderV1
declare type UpdateDecoderV2 = import('./utils/UpdateDecoder.js').UpdateDecoderV2
declare type UpdateEncoderV1 = import('./utils/UpdateEncoder.js').UpdateEncoderV1
declare type UpdateEncoderV2 = import('./utils/UpdateEncoder.js').UpdateEncoderV2
declare type IdSetEncoderV1 = import('./utils/UpdateEncoder.js').IdSetEncoderV1
declare type IdSetEncoderV2 = import('./utils/UpdateEncoder.js').IdSetEncoderV2
declare type IdSetDecoderV1 = import('./utils/UpdateDecoder.js').IdSetDecoderV1
declare type IdSetDecoderV2 = import('./utils/UpdateDecoder.js').IdSetDecoderV2

declare type ID = import('./utils/ID.js').ID
declare type Transaction = import('./utils/Transaction.js').Transaction
declare type StructStore = import('./utils/StructStore.js').StructStore
declare type Doc = import('./utils/Doc.js').Doc
declare type YNode<DConf extends import('lib0-v14/delta').DeltaConf = any> = import('./ynode.js').YNode<DConf>
declare type YEvent<DConf extends import('lib0-v14/delta').DeltaConf> = import('./utils/YEvent.js').YEvent<DConf>
declare type EventHandler<ARG1=any,ARG2=any> = import('./utils/EventHandler.js').EventHandler<ARG1, ARG2>

declare type AbstractStruct = import('./structs/AbstractStruct.js').AbstractStruct
declare type AbstractContent = import('./structs/Item.js').AbstractContent
declare type ContentType = import('./structs/Item.js').ContentType
declare type ContentAny = import('./structs/Item.js').ContentAny
declare type ContentDoc = import('./structs/Item.js').ContentDoc
declare type ContentJSON = import('./structs/Item.js').ContentJSON
declare type ContentEmbed = import('./structs/Item.js').ContentEmbed
declare type ContentFormat = import('./structs/Item.js').ContentFormat
declare type ContentDeleted = import('./structs/Item.js').ContentDeleted
declare type ContentString = import('./structs/Item.js').ContentString

declare type DeltaConf = import('lib0-v14/delta').DeltaConf
declare type Delta<DConf extends DeltaConf> = import('lib0-v14/delta').Delta<DConf>

// @todo the below should have a separate Y/[mod] export
declare type StackItem = import('./utils/UndoManager.js').StackItem
declare type UndoManager = import('./utils/UndoManager.js').UndoManager
declare type AbstractRenderer = import('./utils/renderer-helpers.js').AbstractRenderer
declare type Attribution = import('./utils/renderer-helpers.js').Attribution
declare type AttributedContent<T = any> = import('./utils/renderer-helpers.js').AttributedContent<T>

