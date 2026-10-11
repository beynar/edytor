declare type GC = import('./structs/GC.js').GC
declare type Item = import('./structs/Item.js').Item
declare type Skip = import('./structs/Skip.js').Skip
declare type IdRange = import('./utils/ids.js').IdRange
declare type IdSet = import('./utils/ids.js').IdSet
declare type ContentIds = import('./utils/ids.js').ContentIds


declare type BlockSet = import('./utils/BlockSet.js').BlockSet
declare type UpdateDecoder = import('./utils/UpdateDecoder.js').UpdateDecoder
declare type UpdateEncoder = import('./utils/UpdateEncoder.js').UpdateEncoder
declare type IdSetEncoder = import('./utils/UpdateEncoder.js').IdSetEncoder
declare type IdSetDecoder = import('./utils/UpdateDecoder.js').IdSetDecoder

declare type ID = import('./utils/ID.js').ID
declare type Transaction = import('./utils/Transaction.js').Transaction
declare type StructStore = import('./utils/StructStore.js').StructStore
declare type Doc = import('./utils/Doc.js').Doc
declare type YNode = import('./ynode.js').YNode
declare type YEvent = import('./utils/YEvent.js').YEvent
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


// @todo the below should have a separate Y/[mod] export

