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

  // Insert or update a card coming from the server at its authoritative position.
  // The store is always reconciled to server data, never guessed locally.
  function upsertCard(serverCard) {
    if (!serverCard || serverCard.id == null) return
    // Remove any stale copy first (e.g. card that changed columns)
    removeCardLocally(serverCard.id)
    const colId = serverCard.column_id
    if (!cards.value[colId]) cards.value[colId] = []
    const list = cards.value[colId]
    const pos = Number.isInteger(serverCard.position) ? serverCard.position : list.length
    list.splice(Math.min(Math.max(pos, 0), list.length), 0, serverCard)
  }

  function removeCardLocally(cardId) {
    for (const colId in cards.value) {
      cards.value[colId] = cards.value[colId].filter(c => c.id !== cardId)
    }
  }

  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    upsertCard(res.data)
    return res.data
  }

  async function updateCard(cardId, data) {
    // Server may apply field changes and/or an atomic move (columnId/position)
    const res = await cardApi.update(cardId, data)
    if (data.columnId != null && currentBoard.value) {
      // A move reshuffles positions of other cards too; re-sync to stay exact
      await fetchAllCards(currentBoard.value.id).catch(() => upsertCard(res.data))
    } else {
      upsertCard(res.data)
    }
    return res.data
  }

  async function deleteCard(cardId) {
    await cardApi.delete(cardId)
    removeCardLocally(cardId)
  }

  async function moveCard(cardId, targetColumnId, position) {
    try {
      await cardApi.move(cardId, targetColumnId, position)
    } finally {
      // Whether the request succeeded or failed (it may have been applied on
      // the server but the response was lost), reconcile to authoritative
      // server state so lists, counts and positions can never drift, and a
      // retry is always idempotent.
      if (currentBoard.value) {
        await fetchAllCards(currentBoard.value.id).catch(() => {})
      }
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
    fetchCards, fetchAllCards, addCard, updateCard, deleteCard, moveCard,
    clearBoard
  }
})
