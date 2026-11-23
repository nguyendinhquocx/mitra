import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Entry, EntryType, EntryStatus } from '#features/entries'
import { RelationGraph } from './RelationGraph.js'
import { EntryRelations } from './EntryRelations.js'
import { RelationType } from './RelationType.js'
import { EntryHierarchy } from './EntryHierarchy.js'

describe('EntryHierarchy', () => {
	const task = (uid: string, init?: Partial<Entry>) => new Entry({ id: uid, uid, type: EntryType.Task, heading: uid, ...init })
	const parent = task('parent')
	const finished = task('finished', { status: EntryStatus.Done, relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: 'parent' }]) })
	const pending = task('pending', { relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: 'parent' }]) })

	afterEach(() => EntryHierarchy.from(() => RelationGraph.empty))

	it('stands alone where no graph is registered, as on the server', () => {
		assert.deepEqual(parent.hierarchy.children, [])
		assert.equal(parent.hierarchy.progress, undefined)
	})

	it('reads its subtasks, its parents and their progress off the registered graph', () => {
		EntryHierarchy.from(() => RelationGraph.of([parent, finished, pending]))
		assert.deepEqual(parent.hierarchy.children.map(child => child.uid), ['finished', 'pending'])
		assert.deepEqual(pending.hierarchy.parents.map(entry => entry.uid), ['parent'])
		assert.equal(parent.hierarchy.progress, 0.5)
		assert.equal(pending.hierarchy.progress, undefined, 'a task without subtasks has only its own progress')
	})

	it('states the progress its status leaves unsaid: part of a task, and whatever an event\'s steps come to', () => {
		const trip = new Entry({ id: 'trip', uid: 'trip', type: EntryType.Event, heading: 'trip' })
		const step = (uid: string, status?: EntryStatus) => task(uid, { status, relations: EntryRelations.of([{ type: RelationType.Parent, targetUid: 'trip' }]) })
		const stated = (...entries: Array<Entry>) => {
			EntryHierarchy.from(() => RelationGraph.of(entries))
			return entries[0]!.hierarchy.statedProgress
		}
		assert.equal(stated(parent, finished, pending), 0.5)
		assert.equal(stated(parent, pending), undefined, 'a task to do says none of it is done')
		assert.equal(stated(task('parent', { status: EntryStatus.Done }), finished, pending), undefined, 'a done task says all of it is')
		assert.equal(stated(trip), undefined, 'an event without steps has no progress')
		assert.equal(stated(trip, step('booked'), step('packed')), 0)
		assert.equal(stated(trip, step('booked', EntryStatus.Done), step('packed', EntryStatus.Done)), 1)
		assert.equal(stated(new Entry({ id: 'trip', uid: 'trip', type: EntryType.Event, heading: 'trip', status: EntryStatus.Cancelled }), step('booked')), undefined, 'a cancelled event is closed')
	})
})
