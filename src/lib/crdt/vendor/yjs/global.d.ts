declare type GC = import('./src/structs/GC.js').GC
declare type Item = import('./src/structs/Item.js').Item
declare type Skip = import('./src/structs/Skip.js').Skip
declare type IdRange = import('./src/utils/ids.js').IdRange
declare type IdSet = import('./src/utils/ids.js').IdSet
declare type ContentIds = import('./src/utils/ids.js').ContentIds


declare type BlockSet = import('./src/utils/BlockSet.js').BlockSet
declare type UpdateDecoderV1 = import('./src/utils/UpdateDecoder.js').UpdateDecoderV1
declare type UpdateDecoderV2 = import('./src/utils/UpdateDecoder.js').UpdateDecoderV2
declare type UpdateEncoderV1 = import('./src/utils/UpdateEncoder.js').UpdateEncoderV1
declare type UpdateEncoderV2 = import('./src/utils/UpdateEncoder.js').UpdateEncoderV2
declare type IdSetEncoderV1 = import('./src/utils/UpdateEncoder.js').IdSetEncoderV1
declare type IdSetEncoderV2 = import('./src/utils/UpdateEncoder.js').IdSetEncoderV2
declare type IdSetDecoderV1 = import('./src/utils/UpdateDecoder.js').IdSetDecoderV1
declare type IdSetDecoderV2 = import('./src/utils/UpdateDecoder.js').IdSetDecoderV2

declare type ID = import('./src/utils/ID.js').ID
declare type Transaction = import('./src/utils/Transaction.js').Transaction
declare type StructStore = import('./src/utils/StructStore.js').StructStore
declare type Doc = import('./src/utils/Doc.js').Doc
declare type YNode = import('./src/ynode.js').YNode
declare type YEvent = import('./src/utils/YEvent.js').YEvent
declare type EventHandler<ARG1=any,ARG2=any> = import('./src/utils/EventHandler.js').EventHandler<ARG1, ARG2>

declare type AbstractStruct = import('./src/structs/AbstractStruct.js').AbstractStruct
declare type AbstractContent = import('./src/structs/Item.js').AbstractContent
declare type ContentType = import('./src/structs/Item.js').ContentType
declare type ContentAny = import('./src/structs/Item.js').ContentAny
declare type ContentDoc = import('./src/structs/Item.js').ContentDoc
declare type ContentJSON = import('./src/structs/Item.js').ContentJSON
declare type ContentEmbed = import('./src/structs/Item.js').ContentEmbed
declare type ContentFormat = import('./src/structs/Item.js').ContentFormat
declare type ContentDeleted = import('./src/structs/Item.js').ContentDeleted
declare type ContentString = import('./src/structs/Item.js').ContentString


// @todo the below should have a separate Y/[mod] export
declare type StackItem = import('./src/utils/UndoManager.js').StackItem
declare type UndoManager = import('./src/utils/UndoManager.js').UndoManager

