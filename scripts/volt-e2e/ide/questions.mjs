/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): 12 relationship questions about HAIP (github.com/TelivityAI/haip @ 83f88e5),
// each with ground truth verified by hand (rg + reading the code, see the report) as key facts.
// A fact is found when its regex matches the agent's final answer (and its `not` regex does not).
// Score = facts found / facts. Facts name files or classes so either spelling counts.

/** A file basename (without .ts) or its class name. */
function unit(file, cls) {
	const escaped = file.replace(/[.]/g, '\\.');
	return { label: cls ?? file, re: new RegExp(`(?<![\\w-])${escaped}(?:\\.ts)?(?![\\w-])${cls ? `|\\b${cls}\\b` : ''}`) };
}
function word(label, source = label, flags = '') {
	return { label, re: new RegExp(source, flags) };
}

export const QUESTIONS = [
	{
		id: 'Q1-writers',
		prompt: 'Which non-test source files write to the `reservations` table (Drizzle insert, update or delete on `reservations`)? List each file. Ignore *.spec.ts files and the seed script.',
		facts: [
			unit('inbound-reservation.service', 'InboundReservationService'),
			unit('connect-booking.service', 'ConnectBookingService'),
			unit('connect-payment.service', 'ConnectPaymentService'),
			unit('group-profile.service', 'GroupProfileService'),
			unit('guest-check-in.service', 'GuestCheckInService'),
			unit('night-audit.service', 'NightAuditService'),
			unit('hosted-authorization-finalizer', 'finalizeHostedAuthorization'),
			unit('reservation-party.service', 'ReservationPartyService'),
			unit('reservation.service', 'ReservationService'),
		],
	},
	{
		id: 'Q2-transitions',
		prompt: 'Which functions or methods call `assertTransition` (the reservation status state machine), and with which target status does each call it?',
		facts: [
			word('confirm', '\\bconfirm\\b[^\\n]{0,80}confirmed|confirmed[^\\n]{0,80}\\bconfirm\\b'),
			word('assignRoom', '\\bassignRoom\\b'),
			word('cancel', '\\bcancel\\b[^\\n]{0,80}cancelled|cancelled[^\\n]{0,80}\\bcancel\\b'),
			word('markNoShow', '\\bmarkNoShow\\b'),
			word('checkIn', '\\bcheckIn\\b'),
			word('checkOut', '\\bcheckOut\\b'),
			word('finalizeHostedAuthorization', 'finalizeHostedAuthorization|hosted-authorization-finalizer'),
		],
	},
	{
		id: 'Q3-rename-maxOccupancy',
		prompt: 'If the `maxOccupancy` column property of the `roomTypes` Drizzle table were renamed, which non-test files under apps/api/src read or write it and would need to change? List the files.',
		facts: [
			unit('room.service', 'RoomService'),
			unit('connect-content.service', 'ConnectContentService'),
			unit('connect-search.service', 'ConnectSearchService'),
			unit('reservation-party.service', 'ReservationPartyService'),
			unit('availability.service', 'AvailabilityService'),
			unit('content-sync.service', 'ContentSyncService'),
			unit('import.service', 'ImportService'),
		],
	},
	{
		id: 'Q4-status-routes',
		prompt: 'List every HTTP route in the reservation controller (method and path) that can change a reservation\'s status.',
		facts: ['confirm', 'assign-room', 'cancel', 'no-show', 'check-in', 'check-out', 'express-checkout', 'group-check-in', 'bulk-action']
			.map(path => word(path, `(?<![\\w-])${path}(?![\\w-])`)),
	},
	{
		id: 'Q5-payment-gateways',
		prompt: 'Where is the `PaymentGateway` interface defined, and which classes implement it?',
		facts: [
			word('packages/shared definition', 'payment-gateway\\.interface|packages/shared'),
			...['Stripe', 'Mock', 'Wise', 'Square', 'Adyen', 'Redsys', 'Worldline', 'Mollie', 'Braintree'].map(name => word(`${name}Gateway`, `\\b${name}Gateway\\b|(?<![\\w-])${name.toLowerCase()}-gateway(?![\\w-])`)),
		],
	},
	{
		id: 'Q6-night-audit',
		prompt: 'What status changes does the night audit (NightAuditService) apply to reservations, and which services does NightAuditService inject?',
		facts: [
			word('no_show', 'no_show|markNoShow|no-show'),
			word('stayover', 'stayover'),
			word('due_out', 'due_out|due-out'),
			...['FolioService', 'ReservationService', 'HousekeepingService', 'RoomStatusService', 'WebhookService', 'AncillaryService', 'PolicyService', 'DepositSettlementService'].map(name => word(name, `\\b${name}\\b`)),
		],
	},
	{
		id: 'Q7-module-importers',
		prompt: 'Which NestJS modules import `ReservationModule`?',
		facts: ['Groups', 'BookingEngine', 'Connect', 'GuestCheckIn', 'Migration', 'Waitlist', 'NightAudit', 'Channel', 'App']
			.map(name => word(`${name}Module`, `\\b${name}Module\\b|(?<![\\w-])${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}\\.module`)),
	},
	{
		id: 'Q8-room-fks',
		prompt: 'Which database tables (Drizzle schema) have a foreign key that references `rooms.id`? Include self-references.',
		facts: [
			word('reservations', '\\breservations\\b'),
			word('housekeeping_tasks', 'housekeeping_tasks|housekeepingTasks'),
			word('lost_and_found_items', 'lost_and_found_items|lostAndFoundItems'),
			word('service_requests', 'service_requests|serviceRequests'),
			word('door_lock_credentials', 'door_lock_credentials|doorLockCredentials'),
			word('room_discrepancy_cases', 'room_discrepancy_cases|roomDiscrepancyCases'),
			word('rooms.connecting_room_id (self)', 'connecting_room_id|connectingRoomId'),
		],
	},
	{
		id: 'Q9-cancel-event',
		prompt: 'When ReservationService.cancel runs, what event does it emit, through which service, and which in-process listeners react to that event?',
		facts: [
			word('reservation.cancelled', 'reservation\\.cancelled'),
			word('WebhookService.emit', 'WebhookService|webhookService'),
			word('AriService handler', 'AriService|handleReservationCancelled|ari\\.service'),
			word('@OnEvent / EventEmitter', 'OnEvent|EventEmitter|eventEmitter'),
		],
	},
	{
		id: 'Q10-check-in-chain',
		prompt: 'Trace PATCH /reservations/:id/check-in: which other services does ReservationService.checkIn call, what event does it emit, and which listeners handle that event?',
		facts: [
			word('createAutoFolio', 'createAutoFolio'),
			word('postCharge', 'postCharge'),
			word('authorizePayment', 'authorizePayment'),
			word('markOccupied', 'markOccupied'),
			word('ancillary', 'ensurePackageComponents|postOnceForReservation|AncillaryService'),
			word('applyHeldDeposits', 'applyHeldDeposits'),
			word('reservation.checked_in', 'reservation\\.checked_in'),
			word('GuestCommsListener', 'GuestCommsListener|guest-comms\\.listener'),
			word('DoorLockListener', 'DoorLockListener|door-lock\\.listener'),
			word('FiscalListener', 'FiscalListener|fiscal\\.listener'),
		],
	},
	{
		id: 'Q11-status-sync',
		prompt: 'Where is the reservation status defined in TypeScript and in the database schema, and do the two value sets match?',
		facts: [
			word('state machine type', 'reservation-state-machine|ReservationStatus'),
			word('db enum', 'reservationStatusEnum|reservation_status|schema/reservation'),
			{ label: 'they match', re: /\b(match|identical|same|in sync|consistent|aligned)\b/i, not: /\b(do not|don't|doesn't|does not|not) (match|identical|the same|in sync|consistent|aligned)|mismatch|differ/i },
			word('mentions stayover and due_out', '(?=[\\s\\S]*stayover)(?=[\\s\\S]*due_out)'),
		],
	},
	{
		id: 'Q12-folio-injectors',
		prompt: 'Which classes inject `FolioService` through their constructor? List them.',
		facts: [
			unit('booking-engine.service', 'BookingEngineService'),
			unit('folio.controller', 'FolioController'),
			unit('folio-routing.service', 'FolioRoutingService'),
			unit('deposit.service', 'DepositService'),
			unit('deposit-settlement.service', 'DepositSettlementService'),
			unit('import.service', 'ImportService'),
			unit('ar.service', 'ArService'),
			unit('connect-payment.service', 'ConnectPaymentService'),
			unit('group-profile.service', 'GroupProfileService'),
			unit('stripe-webhook.controller', 'StripeWebhookController'),
			unit('worldline-webhook.controller', 'WorldlineWebhookController'),
			unit('payment.service', 'PaymentService'),
			unit('guest-check-in.service', 'GuestCheckInService'),
			unit('night-audit.service', 'NightAuditService'),
			unit('reservation.service', 'ReservationService'),
			unit('folio-inbound.service', 'FolioInboundService'),
			unit('ancillary.service', 'AncillaryService'),
			unit('pos.service', 'PosService'),
		],
	},
];

export function score(question, answer) {
	const found = question.facts.filter(fact => fact.re.test(answer) && !(fact.not && fact.not.test(answer)));
	return { score: found.length / question.facts.length, found: found.map(f => f.label), missing: question.facts.filter(f => !found.includes(f)).map(f => f.label) };
}
