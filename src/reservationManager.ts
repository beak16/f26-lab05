import { findFreeSlots } from './availability';
import { DEFAULT_CACHE_CONFIG } from './cache/cacheConfig';
import { QueryCache } from './cache/queryCache';
import type { NotificationChannel } from './notifications/channel';
import { createNotificationChannel, DEFAULT_NOTIFIER_CONFIG } from './notifications/notifierFactory';
import { priceFor } from './pricing';
import { InMemoryStorageProvider } from './storage/inMemoryStorageProvider';
import type { StorageProvider } from './storage/storageProvider';
import type { Booking, ReservationRequest, Room } from './types';
import { validateReservationRequest } from './validation';

/** Raised when a request cannot become a booking. */
export class BookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingError';
  }
}

/**
 * Entry point for the reservation service. Holds the room registry, creates and
 * cancels bookings, prices them, sends the confirmations, and formats the
 * receipts and summaries callers print.
 */
export class ReservationManager {
  private readonly storage: StorageProvider;
  private readonly notifier: NotificationChannel;
  private readonly cache: QueryCache;
  private readonly rooms = new Map<string, Room>();
  private readonly notificationLog: string[] = [];
  private nextBookingNumber = 1;

  constructor(storage: StorageProvider = new InMemoryStorageProvider()) {
    this.storage = storage;
    this.notifier = createNotificationChannel(DEFAULT_NOTIFIER_CONFIG);
    this.cache = new QueryCache(DEFAULT_CACHE_CONFIG);
  }

  registerRoom(room: Room): void {
    this.rooms.set(room.id, room);
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  listRooms(): Room[] {
    return [...this.rooms.values()];
  }

  /** Validates, checks for conflicts, prices, stores, and confirms a request. */
  createBooking(request: ReservationRequest): Booking {
    const room = this.rooms.get(request.roomId);
    if (room === undefined) {
      throw new BookingError(`unknown room ${request.roomId}`);
    }

    const validation = validateReservationRequest(request, room);
    if (!validation.valid) {
      throw new BookingError(validation.reason ?? 'invalid reservation request');
    }

    for (const existing of this.storage.findByRoom(request.roomId)) {
      if (existing.status !== 'confirmed') {
        continue;
      }
      if (this.hasConflict(existing.start, existing.end, request.start, request.end)) {
        throw new BookingError(
          `room ${room.id} is already booked from ${this.formatClock(existing.start)} to ${this.formatClock(existing.end)}`,
        );
      }
    }

    const booking: Booking = {
      id: `bk-${this.nextBookingNumber}`,
      roomId: request.roomId,
      organizer: request.organizer,
      attendees: request.attendees,
      start: request.start,
      end: request.end,
      status: 'confirmed',
      priceCents: this.calculatePrice(room, request.start, request.end),
      notes: request.notes,
    };
    this.nextBookingNumber += 1;

    this.storage.save(booking);
    this.dispatchNotification(booking, 'Reservation confirmed');
    return booking;
  }

  /** Marks a booking cancelled and tells the organizer. Cancelling twice is a no-op. */
  cancelBooking(bookingId: string): Booking {
    const booking = this.storage.findById(bookingId);
    if (booking === undefined) {
      throw new BookingError(`unknown booking ${bookingId}`);
    }
    if (booking.status === 'cancelled') {
      return booking;
    }

    const cancelled: Booking = { ...booking, status: 'cancelled' };
    this.storage.update(cancelled);
    this.dispatchNotification(cancelled, 'Reservation cancelled');
    return cancelled;
  }

  getBooking(bookingId: string): Booking | undefined {
    return this.storage.findById(bookingId);
  }

  listBookingsForRoom(roomId: string): Booking[] {
    const cacheKey = `bookings:${roomId}`;
    const cached = this.cache.get<Booking[]>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    return this.storage.findByRoom(roomId);
  }

  /** Start minutes of every open slot of the requested length inside the window. */
  findAvailableSlots(
    roomId: string,
    windowStart: number,
    windowEnd: number,
    slotMinutes: number,
  ): number[] {
    const confirmed = this.storage
      .findByRoom(roomId)
      .filter((booking) => booking.status === 'confirmed');
    return findFreeSlots(confirmed, windowStart, windowEnd, slotMinutes);
  }

  /** Price in cents for holding a room between two minute marks. */
  calculatePrice(room: Room, start: number, end: number): number {
    return priceFor(room, start, end);
  }

  private hasConflict(
    existingStart: number,
    existingEnd: number,
    requestedStart: number,
    requestedEnd: number,
  ): boolean {
    if (requestedEnd <= existingStart) {
      return false;
    }
    if (requestedStart >= existingEnd) {
      return false;
    }
    return true;
  }

  /** Customer facing receipt for one booking. */
  formatReceipt(booking: Booking): string {
    const room = this.rooms.get(booking.roomId);
    const roomName = room === undefined ? booking.roomId : room.name;
    const window = `${this.formatClock(booking.start)} to ${this.formatClock(booking.end)}`;
    const lines = [
      `Booking ${booking.id} (${booking.status})`,
      `${roomName}, ${window}`,
      `Organizer: ${booking.organizer} for ${booking.attendees} attendee(s)`,
      `Total: ${this.formatMoney(booking.priceCents)}`,
    ];
    if (booking.notes !== undefined && booking.notes !== '') {
      lines.push(`Notes: ${booking.notes}`);
    }
    return lines.join('\n');
  }

  /** One line per booking on a room, plus a confirmed total. */
  formatDailySummary(roomId: string): string {
    const bookings = this.listBookingsForRoom(roomId);
    const room = this.rooms.get(roomId);
    const header = `Schedule for ${room === undefined ? roomId : room.name}`;
    if (bookings.length === 0) {
      return `${header}\n(nothing booked)`;
    }
    const rows = bookings.map(
      (booking) =>
        `${this.formatClock(booking.start)}-${this.formatClock(booking.end)}  ${booking.organizer}  ${this.formatMoney(booking.priceCents)}  ${booking.status}`,
    );
    const confirmedTotal = bookings
      .filter((booking) => booking.status === 'confirmed')
      .reduce((sum, booking) => sum + booking.priceCents, 0);
    return [header, ...rows, `Confirmed total: ${this.formatMoney(confirmedTotal)}`].join('\n');
  }

  /** Messages this manager has sent, newest last. */
  recentNotifications(): string[] {
    return [...this.notificationLog];
  }

  private dispatchNotification(booking: Booking, subject: string): void {
    const result = this.notifier.send(booking.organizer, subject, this.formatReceipt(booking));
    this.notificationLog.push(`${result.channel}:${result.recipient}:${subject}`);
  }

  private formatClock(minute: number): string {
    const hours = Math.floor(minute / 60);
    const minutes = minute % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private formatMoney(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
