import BLOG from '@/blog.config'
import { getDataFromCache, setDataToCache } from '@/lib/cache/cache_manager'
import { NotionAPI } from 'notion-client'
import { deepClone, delay } from '../utils'

function createNotionAPI() {
  const authToken = BLOG.NOTION_ACCESS_TOKEN || null
  return new NotionAPI({
    authToken,
    userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  })
}

function normalizeRecordMapEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return entry
  }

  const nestedValue = entry?.value?.value
  if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
    return entry
  }

  const normalizedEntry = {
    ...entry,
    value: nestedValue
  }

  const role = entry?.role || entry?.value?.role
  if (role) {
    normalizedEntry.role = role
  }

  return normalizedEntry
}

function normalizeRecordMapTable(table) {
  if (!table || typeof table !== 'object') {
    return table
  }

  const normalizedTable = {}
  for (const key of Object.keys(table)) {
    normalizedTable[key] = normalizeRecordMapEntry(table[key])
  }
  return normalizedTable
}

function normalizeRecordMap(recordMap) {
  if (!recordMap || typeof recordMap !== 'object') {
    return recordMap
  }

  return {
    ...recordMap,
    block: normalizeRecordMapTable(recordMap.block),
    collection: normalizeRecordMapTable(recordMap.collection),
    collection_view: normalizeRecordMapTable(recordMap.collection_view),
    notion_user: normalizeRecordMapTable(recordMap.notion_user)
  }
}

function mergeRecordMapTables(targetTable = {}, sourceTable = {}) {
  return {
    ...targetTable,
    ...normalizeRecordMapTable(sourceTable)
  }
}

function getCollectionBlocks(recordMap) {
  if (!recordMap?.block) {
    return []
  }

  return Object.values(recordMap.block)
    .map(normalizeRecordMapEntry)
    .filter(entry => {
      const type = entry?.value?.type
      return type === 'collection_view' || type === 'collection_view_page'
    })
}

async function hydrateCollectionQueries(api, pageData) {
  const recordMap = normalizeRecordMap(pageData)
  if (!recordMap) {
    return recordMap
  }

  recordMap.collection_query = recordMap.collection_query || {}
  const collectionBlocks = getCollectionBlocks(recordMap)

  for (const block of collectionBlocks) {
    const metadata = block?.value
    const collectionId = metadata?.collection_id
    const viewIds = metadata?.view_ids || []

    if (!collectionId || viewIds.length === 0) {
      continue
    }

    recordMap.collection_query[collectionId] = recordMap.collection_query[collectionId] || {}

    let fetched = false

    for (const viewId of viewIds) {
      if (recordMap.collection_query[collectionId][viewId]) {
        fetched = true
        break
      }

      const view = recordMap.collection_view?.[viewId]?.value
      if (!view) {
        continue
      }

      try {
        const collectionData = await api.getCollectionData(collectionId, viewId, view)

        recordMap.block = mergeRecordMapTables(recordMap.block, collectionData?.recordMap?.block)
        recordMap.collection = mergeRecordMapTables(
          recordMap.collection,
          collectionData?.recordMap?.collection
        )
        recordMap.collection_view = mergeRecordMapTables(
          recordMap.collection_view,
          collectionData?.recordMap?.collection_view
        )
        recordMap.notion_user = mergeRecordMapTables(
          recordMap.notion_user,
          collectionData?.recordMap?.notion_user
        )

        recordMap.collection_query[collectionId][viewId] =
          collectionData?.result?.reducerResults || {}

        fetched = true
        break
      } catch (error) {
        // Ignore invalid views silently and continue trying the next available view.
      }
    }

    if (!fetched) {
      console.warn('[API<<--异常]: 未找到可用的 collection view', collectionId)
    }
  }

  return recordMap
}

/**
 * 获取文章内容
 * @param {*} id
 * @param {*} from
 * @param {*} slice
 * @returns
 */
export async function getPage(id, from, slice) {
  const cacheKey = 'page_block_' + id
  let pageBlock = normalizeRecordMap(await getDataFromCache(cacheKey))
  if (pageBlock) {
    // console.log('[API<<--缓存]', `from:${from}`, cacheKey)
    return filterPostBlocks(id, pageBlock, slice)
  }

  pageBlock = normalizeRecordMap(await getPageWithRetry(id, from))

  if (pageBlock) {
    await setDataToCache(cacheKey, pageBlock)
    return filterPostBlocks(id, pageBlock, slice)
  }
  return pageBlock
}

/**
 * 调用接口，失败会重试
 * @param {*} id
 * @param {*} retryAttempts
 */
export async function getPageWithRetry(id, from, retryAttempts = 3) {
  if (retryAttempts && retryAttempts > 0) {
    console.log(
      '[API-->>请求]',
      `from:${from}`,
      `id:${id}`,
      retryAttempts < 3 ? `剩余重试次数:${retryAttempts}` : ''
    )
    try {
      const api = createNotionAPI()
      const start = new Date().getTime()
      const pageData = await api.getPage(id, { fetchCollections: false })
      const hydratedPageData = await hydrateCollectionQueries(api, pageData)
      const end = new Date().getTime()
      console.log('[API<<--响应]', `耗时:${end - start}ms - from:${from}`)
      return normalizeRecordMap(hydratedPageData)
    } catch (e) {
      console.warn('[API<<--异常]:', e)
      await delay(1000)
      const cacheKey = 'page_block_' + id
      const pageBlock = normalizeRecordMap(await getDataFromCache(cacheKey))
      if (pageBlock) {
        // console.log('[重试缓存]', `from:${from}`, `id:${id}`)
        return pageBlock
      }
      return await getPageWithRetry(id, from, retryAttempts - 1)
    }
  } else {
    console.error('[请求失败]:', `from:${from}`, `id:${id}`)
    return null
  }
}

/**
 * 获取到的页面BLOCK特殊处理
 * 1.删除冗余字段
 * 2.比如文件、视频、音频、url格式化
 * 3.代码块等元素兼容
 * @param {*} id 页面ID
 * @param {*} blockMap 页面元素
 * @param {*} slice 截取数量
 * @returns
 */
function filterPostBlocks(id, blockMap, slice) {
  const clonePageBlock = deepClone(blockMap)
  let count = 0

  // 循环遍历文档的每个block
  for (const i in clonePageBlock?.block) {
    const b = clonePageBlock?.block[i]
    if (slice && slice > 0 && count > slice) {
      delete clonePageBlock?.block[i]
      continue
    }
    // 当BlockId等于PageId时移除
    if (b?.value?.id === id) {
      // 此block含有敏感信息
      delete b?.value?.properties
      continue
    }

    count++
    // 处理 c++、c#、汇编等语言名字映射
    if (b?.value?.type === 'code') {
      if (b?.value?.properties?.language?.[0][0] === 'C++') {
        b.value.properties.language[0][0] = 'cpp'
      }
      if (b?.value?.properties?.language?.[0][0] === 'C#') {
        b.value.properties.language[0][0] = 'csharp'
      }
      if (b?.value?.properties?.language?.[0][0] === 'Assembly') {
        b.value.properties.language[0][0] = 'asm6502'
      }
    }

    // 如果是文件，或嵌入式PDF，需要重新加密签名
    if (
      (b?.value?.type === 'file' ||
        b?.value?.type === 'pdf' ||
        b?.value?.type === 'video' ||
        b?.value?.type === 'audio') &&
      b?.value?.properties?.source?.[0][0] &&
      b?.value?.properties?.source?.[0][0].indexOf('amazonaws.com') > 0
    ) {
      const oldUrl = b?.value?.properties?.source?.[0][0]
      const newUrl = `https://notion.so/signed/${encodeURIComponent(oldUrl)}?table=block&id=${b?.value?.id}`
      b.value.properties.source[0][0] = newUrl
    }
  }

  // 去掉不用的字段
  if (id === BLOG.NOTION_PAGE_ID) {
    return clonePageBlock
  }
  return clonePageBlock
}

/**
 * 根据[]ids，批量抓取blocks
 * 在获取数据库文章列表时，超过一定数量的block会被丢弃，因此根据pageId批量抓取block
 * @param {*} ids
 * @param {*} batchSize
 * @returns
 */
export const fetchInBatches = async (ids, batchSize = 100) => {
  // 如果 ids 不是数组，则将其转换为数组
  if (!Array.isArray(ids)) {
    ids = [ids]
  }

  const api = createNotionAPI()

  let fetchedBlocks = {}
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize)
    console.log('[API-->>请求] Fetching missing blocks', batch, ids.length)
    const start = new Date().getTime()
    const pageChunk = await api.getBlocks(batch)
    const end = new Date().getTime()
    console.log(
      `[API<<--响应] 耗时:${end - start}ms Fetching missing blocks count:${ids.length} `
    )

    console.log('[API<<--响应]')
    fetchedBlocks = Object.assign(
      {},
      fetchedBlocks,
      normalizeRecordMapTable(pageChunk?.recordMap?.block)
    )
  }
  return fetchedBlocks
}
