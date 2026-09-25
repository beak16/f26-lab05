import { priceFor } from './pricing';
import type { StorageProvider } from './storage/storageProvider';
import type { Room } from './types';

export interface OccupancyReport {
  roomId: string;
  roomName: string;
  bookingCount: number;
  bookedMinutes: number;
  windowMinutes: number;
  utilizationPercent: number;
}

export interface RevenueReport {
  bookingCount: number;
  totalCents: number;
  averageCents: number;
  byRoom: Record<string, number>;
}

/** Builds occupancy and revenue reports over the stored bookings. */
export class ReportGenerator {
  private readonly storage: StorageProvider;
  private readonly rooms: Room[];

  constructor(storage: StorageProvider, rooms: Room[]) {
    this.storage = storage;
    this.rooms = rooms;
  }

  occupancy(roomId: string, windowStart: number, windowEnd: number): OccupancyReport {
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    const bookings = this.storage
      .findByRoom(roomId)
      .filter((booking) => booking.status === 'confirmed')
      .filter((booking) => this.overlapsWindow(booking.start, booking.end, windowStart, windowEnd));

    let bookedMinutes = 0;
    for (const booking of bookings) {
      const from = booking.start < windowStart ? windowStart : booking.start;
      const to = booking.end > windowEnd ? windowEnd : booking.end;
      bookedMinutes += to - from;
    }

    const windowMinutes = windowEnd - windowStart;
    return {
      roomId,
      roomName: room === undefined ? roomId : room.name,
      bookingCount: bookings.length,
      bookedMinutes,
      windowMinutes,
      utilizationPercent: windowMinutes <= 0 ? 0 : Math.round((bookedMinutes / windowMinutes) * 100),
    };
  }

  revenue(windowStart: number, windowEnd: number): RevenueReport {
    const byRoom: Record<string, number> = {};
    let totalCents = 0;
    let bookingCount = 0;

    for (const booking of this.storage.findAll()) {
      if (booking.status !== 'confirmed') {
        continue;
      }
      if (!this.overlapsWindow(booking.start, booking.end, windowStart, windowEnd)) {
        continue;
      }
      const room = this.rooms.find((candidate) => candidate.id === booking.roomId);
      if (room === undefined) {
        continue;
      }
      const cents = priceFor(room, booking.start, booking.end);
      byRoom[booking.roomId] = (byRoom[booking.roomId] ?? 0) + cents;
      totalCents += cents;
      bookingCount += 1;
    }

    return {
      bookingCount,
      totalCents,
      averageCents: bookingCount === 0 ? 0 : Math.round(totalCents / bookingCount),
      byRoom,
    };
  }

  private overlapsWindow(
    bookingStart: number,
    bookingEnd: number,
    windowStart: number,
    windowEnd: number,
  ): boolean {
    return Math.max(bookingStart, windowStart) < Math.min(bookingEnd, windowEnd);
  }
}
