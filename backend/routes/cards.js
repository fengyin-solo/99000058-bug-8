const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// Helper: verify card ownership through column -> board -> user
function getCardWithOwnership(db, cardId, userId) {
  return db.prepare(`
    SELECT c.*, col.board_id, b.user_id 
    FROM cards c
    JOIN columns col ON c.column_id = col.id
    JOIN boards b ON col.board_id = b.id
    WHERE c.id = ?
  `).get(cardId);
}

// Verify a target column belongs to the same board as the card.
function findTargetColumn(db, columnId, boardId) {
  return db.prepare(`
    SELECT col.*, b.user_id FROM columns col
    JOIN boards b ON col.board_id = b.id
    WHERE col.id = ? AND col.board_id = ?
  `).get(columnId, boardId);
}

// Shift positions and move a card. Must run inside a transaction so a
// failure never leaves columns half-shifted.
function moveCardInTransaction(db, card, targetColumnId, position) {
  const oldColumnId = card.column_id;
  const oldPosition = card.position;

  if (oldColumnId === targetColumnId && position === oldPosition) {
    return oldPosition;
  }

  // Remove card from its old position, compacting the source column first.
  // This makes the math identical for same-column reorders and cross-column moves.
  db.prepare(`
    UPDATE cards SET position = position - 1
    WHERE column_id = ? AND position > ?
  `).run(oldColumnId, oldPosition);

  // Max position in the target column *with the card removed* from the source.
  const maxPosRow = db.prepare('SELECT MAX(position) AS maxPos FROM cards WHERE column_id = ?').get(targetColumnId);
  let newPosition = position !== undefined ? position : (maxPosRow.maxPos ?? -1) + 1;
  newPosition = Math.max(0, Math.min(newPosition, (maxPosRow.maxPos ?? -1) + 1));

  // Make room in target column.
  db.prepare(`
    UPDATE cards SET position = position + 1
    WHERE column_id = ? AND position >= ?
  `).run(targetColumnId, newPosition);

  // Move the card.
  db.prepare(`
    UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(targetColumnId, newPosition, card.id);

  return newPosition;
}

// GET /api/columns/:columnId/cards - Get cards in column
router.get('/columns/:columnId/cards', (req, res) => {
  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col 
      JOIN boards b ON col.board_id = b.id 
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    const cards = db.prepare(`
      SELECT * FROM cards 
      WHERE column_id = ? 
      ORDER BY position ASC
    `).all(req.params.columnId);

    db.close();
    res.json(cards);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

// POST /api/columns/:columnId/cards - Add card
router.post('/columns/:columnId/cards', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Card title is required' });
  }

  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col 
      JOIN boards b ON col.board_id = b.id 
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get max position in this column
    const maxPos = db.prepare('SELECT MAX(position) AS maxPos FROM cards WHERE column_id = ?').get(req.params.columnId);
    const newPosition = (maxPos.maxPos ?? -1) + 1;

    const result = db.prepare(`
      INSERT INTO cards (column_id, title, description, priority, due_date, position) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.columnId,
      title.trim(),
      description || '',
      priority || 'medium',
      due_date || null,
      newPosition
    );

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid);
    db.close();
    res.status(201).json(card);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PUT /api/cards/:id - Update card (fields and/or column move, atomically)
router.put('/cards/:id', (req, res) => {
  const { title, description, priority, due_date, columnId, position } = req.body;
  const db = getDb();

  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    let targetColumnId = card.column_id;
    if (columnId !== undefined && columnId !== null) {
      const targetCol = findTargetColumn(db, columnId, card.board_id);
      if (!targetCol || targetCol.user_id !== req.user.id) {
        db.close();
        return res.status(404).json({ error: 'Target column not found in this board' });
      }
      targetColumnId = columnId;
    }

    const updateCard = db.transaction(() => {
      const updates = [];
      const params = [];

      if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
      if (description !== undefined) { updates.push('description = ?'); params.push(description); }
      if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
      if (due_date !== undefined) { updates.push('due_date = ?'); params.push(due_date || null); }

      if (columnId !== undefined && columnId !== null) {
        moveCardInTransaction(db, card, targetColumnId, position);
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        params.push(req.params.id);
        db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
    });

    updateCard();

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to update card' });
  }
});

// DELETE /api/cards/:id - Delete card
router.delete('/cards/:id', (req, res) => {
  const db = getDb();
  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);

    // Reorder remaining cards in the column
    db.prepare(`
      UPDATE cards SET position = position - 1 
      WHERE column_id = ? AND position > ?
    `).run(card.column_id, card.position);

    db.close();
    res.json({ message: 'Card deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// PUT /api/cards/:id/move - Move card to another column
router.put('/cards/:id/move', (req, res) => {
  const { columnId, position } = req.body;
  if (!columnId) {
    return res.status(400).json({ error: 'Target column ID is required' });
  }

  const db = getDb();
  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column belongs to same board and user
    const targetCol = findTargetColumn(db, columnId, card.board_id);
    if (!targetCol || targetCol.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Target column not found in this board' });
    }

    db.transaction(() => {
      moveCardInTransaction(db, card, columnId, position);
    })();

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move card' });
  }
});

module.exports = router;
