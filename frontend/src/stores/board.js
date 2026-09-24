import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

export const useBoardStore = defineStore('board', () => {
  const boards = ref([])
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const loading = ref(false)

  // Board actions
  async function fetchBoards() {
    loading.value = true
    try {
      const res = await boardApi.list()
      boards.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function createBoard(name, description) {
    const res = await boardApi.create(name, description)
    boards.value.unshift(res.data)
    return res.data
  }

  async function deleteBoard(id) {
    await boardApi.delete(id)
    boards.value = boards.value.filter(b => b.id !== id)
  }

  // Column actions
  async function fetchColumns(boardId) {
    loading.value = true
    try {
      const res = await columnApi.list(boardId)
      columns.value = res.data
      // Initialize cards map
      cards.value = {}
      for (const col of res.data) {
        cards.value[col.id] = []
      }
    } finally {
      loading.value = false
    }
  }

  async function addColumn(boardId, name) {
    const res = await columnApi.create(boardId, name)
    columns.value.push(res.data)
    cards.value[res.data.id] = []
    return res.data
  }

  async function renameColumn(colId, name) {
    const res = await columnApi.update(colId, { name })
    const idx = columns.value.findIndex(c => c.id === colId)
    if (idx !== -1) columns.value[idx] = res.data
    return res.data
  }

  async function deleteColumn(colId) {
    await columnApi.delete(colId)
    columns.value = columns.value.filter(c => c.id !== colId)
    delete cards.value[colId]
  }

  async function reorderColumn(colId, newPosition) {
    const res = await columnApi.update(colId, { position: newPosition })
    // Refresh columns to get correct order
    if (currentBoard.value) {
      await fetchColumns(currentBoard.value.id)
    }
    return res.data
  }

  // Card actions
  async function fetchCards(columnId) {
    const res = await cardApi.list(columnId)
    cards.value[columnId] = res.data
    return res.data
  }

  async function fetchAllCards(boardId) {
    // Fetch cards for all columns in parallel
    const cols = columns.value
    const promises = cols.map(col => cardApi.list(col.id))
    const results = await Promise.all(promises)
    cols.forEach((col, i) => {
      cards.value[col.id] = results[i].data
    })
  }

  // --- Single source of truth helpers ---
  // The server is authoritative: every mutation is reconciled against its
  // response (or refetched when the outcome is unknown), so the list,
  // column counts and reopened card can never drift from what was written.

  function findCard(cardId) {
    for (const colId in cards.value) {
      const found = cards.value[colId].find(c => c.id === cardId)
      if (found) return found
    }
    return null
  }

  // Place a card exactly where the server says it is, removing any stale
  // copy left in another column.
  function upsertCard(serverCard) {
    for (const colId in cards.value) {
      cards.value[colId] = cards.value[colId].filter(c => c.id !== serverCard.id)
    }
    if (!cards.value[serverCard.column_id]) cards.value[serverCard.column_id] = []
    const list = cards.value[serverCard.column_id]
    const pos = Math.max(0, Math.min(serverCard.position ?? list.length, list.length))
    list.splice(pos, 0, serverCard)
  }

  // A response means the server accepted or rejected the request for sure.
  // No response (network/timeout) is ambiguous: the write may have landed,
  // so resync from the server before surfacing the error.
  async function resyncOnAmbiguous(err) {
    if (!err.response) {
      try { await fetchAllCards() } catch (_) { /* keep original error */ }
    }
    throw err
  }

  async function addCard(columnId, data) {
    try {
      const res = await cardApi.create(columnId, data)
      if (!cards.value[columnId]) cards.value[columnId] = []
      cards.value[columnId].push(res.data)
      return res.data
    } catch (err) {
      if (!err.response) {
        // Request may have succeeded despite the lost response. Resync and
        // recover the card if it actually made it to the server.
        try { await fetchAllCards() } catch (_) { /* fall through */ }
        const title = (data.title || '').trim()
        const recovered = (cards.value[columnId] || [])
          .slice()
          .reverse()
          .find(c => c.title === title)
        if (recovered) return recovered
      }
      throw err
    }
  }

  async function updateCard(cardId, data) {
    try {
      const res = await cardApi.update(cardId, data)
      upsertCard(res.data)
      // A move rewrites positions in two columns; refetch so order/counts match.
      if (data.columnId !== undefined && data.columnId !== null) {
        try { await fetchAllCards() } catch (_) { /* res.data is already applied */ }
      }
      return res.data
    } catch (err) {
      return resyncOnAmbiguous(err)
    }
  }

  async function deleteCard(cardId) {
    try {
      await cardApi.delete(cardId)
      for (const colId in cards.value) {
        cards.value[colId] = cards.value[colId].filter(c => c.id !== cardId)
      }
    } catch (err) {
      if (!err.response) {
        try { await fetchAllCards() } catch (_) { /* fall through */ }
        // Delete may have landed despite the lost response.
        if (!findCard(cardId)) return
      }
      throw err
    }
  }

  async function moveCard(cardId, targetColumnId, position) {
    try {
      const res = await cardApi.move(cardId, targetColumnId, position)
      upsertCard(res.data)
      // Refetch to align positions in both affected columns.
      try { await fetchAllCards() } catch (_) { /* res.data is already applied */ }
      return res.data
    } catch (err) {
      // A definitive rejection (e.g. target column gone) must snap the
      // optimistically dragged card back; an ambiguous failure must adopt
      // whatever the server actually wrote. Either way resync.
      try { await fetchAllCards() } catch (_) { /* surface original error */ }
      throw err
    }
  }

  function clearBoard() {
    currentBoard.value = null
    columns.value = []
    cards.value = {}
  }

  return {
    boards, currentBoard, columns, cards, loading,
    fetchBoards, createBoard, deleteBoard,
    fetchColumns, addColumn, renameColumn, deleteColumn, reorderColumn,
    fetchCards, fetchAllCards, addCard, updateCard, deleteCard, moveCard, findCard,
    clearBoard
  }
})
