# reservation-service: Smells and One Fix

Fill in each section. One section per milestone. Keep it short and specific. Point at files
and methods, not adjectives.

---

## Milestone 1: Three smells

Three smells, each in a different part of the module. For each one, fill in all five parts.

### Smell 1

**The smell.** Duplication over reuse. The booking pricing policy is written out twice:
base hourly rate, then the premium surcharge (x1.15), the 3+ hour discount (x0.9), and the
evening discount (x0.95), each followed by rounding.

**Classic or agent-specific.** Agent-specific. The report code re-implements a rule that
already existed instead of reusing it. The constants have the same values under different
names (`PREMIUM_MULTIPLIER` vs `PREMIUM_RATE_MULTIPLIER`, `EVENING_START_MINUTE` vs
`EVENING_CUTOFF`). That points to **missing context** as the most likely cause: the report
code looks like it was written without knowing that `calculatePrice` existed, or that every
`Booking` already stores its price in `priceCents`.

**Where in the code.** `src/reportGenerator.ts`, `ReportGenerator.priceOf()` and its
constants (lines 4-8, before the Milestone 2 fix). `src/reservationManager.ts`,
`ReservationManager.calculatePrice()` / `applyDiscounts()` and their constants (lines 11-15,
before the Milestone 2 fix). `ReportGenerator.revenue()` calls
`priceOf()` to recompute each price.

**The principle it violates.** Information Expert, plus one owner for each business rule.
The pricing rule should live in exactly one place, and the booking already knows its own
price.

**What it makes expensive.** Changing a pricing rule, for example making the evening
discount 10% instead of 5%, requires finding and editing both files. If only
`ReservationManager` changes, new bookings are charged the new price but
`ReportGenerator.revenue()` keeps totaling with the old rule. The revenue report then
disagrees with what customers were actually charged, and no type error or error message
warns you.

### Smell 2

**The smell.** Phantom complexity. `src/cache/` provides a full query cache (TTL expiry,
a max-entry eviction policy, an enabled/disabled switch, per-key invalidation, and config
helpers), but nothing ever puts anything into it. The cache never actually caches.

**Classic or agent-specific.** Agent-specific. The most plausible cause is **free volume**.
The generated machinery goes well beyond what the code uses: `QueryCache.set()`,
`invalidate()`, `size()`, `withTtl()`, and `disabled()` have no callers in `src/` or
`tests/`. The code cannot tell us why this was generated. But "extra infrastructure nobody
uses" fits free volume better than the other two causes.

**Where in the code.** `src/cache/queryCache.ts` (`QueryCache`) and
`src/cache/cacheConfig.ts`. The only consumer is
`ReservationManager.listBookingsForRoom()` in `src/reservationManager.ts`. It calls
`this.cache.get()`, which always misses because nothing calls `set()`, and then falls
through to `storage.findByRoom()` every time.

**The principle it violates.** Every abstraction should earn its place (YAGNI / avoid
speculative generality). The code looks like it provides caching when it provides none, so
it misleads readers about how the system behaves.

**What it makes expensive.** "Finishing" the cache in the obvious way is a trap. If someone
adds `this.cache.set(...)` in `listBookingsForRoom()`, the cached list goes stale.
`createBooking()` and `cancelBooking()` never invalidate the key. So for up to 30 seconds
(the default TTL), `listBookingsForRoom()` and `formatDailySummary()` would miss new
bookings and still show cancelled ones as confirmed. Until then, every reader has to work
out that roughly 80 lines of cache code do nothing.

### Smell 3

**The smell.** Hidden dependencies. `ReservationManager` creates its own notifier and cache
inside its constructor instead of receiving them as parameters. Storage is the only
dependency a caller can pass in.

**Classic or agent-specific.** Classic.

**Where in the code.** `src/reservationManager.ts`, the `ReservationManager` constructor
(lines 33-37 after the Milestone 2 change): `this.notifier = createNotificationChannel(DEFAULT_NOTIFIER_CONFIG)` and
`this.cache = new QueryCache(DEFAULT_CACHE_CONFIG)`. The notifier comes from
`src/notifications/notifierFactory.ts`, which keeps a module-level `builders` registry that
is filled when the module is imported (`registerChannel('email', ...)`, line 42).

**The principle it violates.** Controllability, and depending on abstractions rather than
concrete setup. The class already uses the `NotificationChannel` interface internally, but
the constructor ties it to the default email channel, so the interface cannot be used to
substitute a different notifier.

**What it makes expensive.** Testing notification behavior. A test cannot pass in a fake
channel to check a message body, or to simulate `delivered: false`. It can only inspect
the summary strings from `recentNotifications()`. The only way to swap the notifier is to
call `registerChannel('email', ...)`, which changes global state for every
`ReservationManager` created afterward in the same process, including ones in other tests.
Adding a second channel such as SMS for one deployment means editing the
`ReservationManager` constructor rather than passing a different channel in.

---

## Milestone 2: One small fix

One fix, behavior preserved, suite green, zero test edits.

**Which smell you attacked.** Smell 1, the duplicated pricing rule. It was the smallest fix
that could be shown to preserve behavior. The two copies did exactly the same arithmetic in
the same order: round the base price, then premium x1.15, then the 3+ hour discount x0.9,
then the evening discount x0.95, rounding after each step. Merging them could not change
any output. It also removes the specific failure from Milestone 1, where one pricing change
could update booking prices without updating the revenue report.

**What changed.**
- New file `src/pricing.ts` with one exported function, `priceFor(room, start, end)`. It
  holds the five pricing constants and the calculation. It is a plain function, not a
  class, because the rule has no state.
- `src/reservationManager.ts`: `calculatePrice()` keeps its public signature and now
  just returns `priceFor(room, start, end)`. The private `applyDiscounts()` and the five
  local constants are deleted.
- `src/reportGenerator.ts`: `revenue()` now calls `priceFor(room, booking.start,
  booking.end)`. The private `priceOf()`, the private `durationOf()` (only `priceOf()` used
  it), the five renamed constants, and the now-unused `Booking` import are deleted.

The pricing rule now lives in exactly one place. Both classes depend on that small module,
not on each other.

**What you deliberately did not touch.** Scope line: remove the duplicated calculation and
change nothing about *when* or *on what data* each class calculates a price.
`ReportGenerator.revenue()` still recomputes prices from its `rooms` snapshot instead of
reading the stored `Booking.priceCents`. Switching to the stored price would be a better
design, but it changes results when a room's rate changes after booking, or when a room is
missing from the snapshot. That makes it a behavior change, not a refactoring. I also left
the duplicated overlap/time-range checks, the unused cache, the notifier wiring, and the
rest of `ReservationManager` alone. They are separate smells, and mixing them in would
make it impossible to tell which change caused a test failure.

**How you know behavior is preserved.** `npm test` passes all 39 tests with zero test
edits, and `npm run typecheck` is clean. Tests that exercise the shared rule:
- Manager path, `tests/booking.test.ts` "pricing": plain 2h = 12000, 3h long-booking
  discount = 16200, premium surcharge = 18400, evening discount = 11400. "room schedules"
  also checks the stored prices add up to `$234.00`.
- Report path, `tests/reporting.test.ts` "totals revenue over the window": revenue
  `totalCents` must equal the sum of the stored `priceCents`, with `averageCents` = 11700 and
  `byRoom` = `{ r1: 23400 }`. "leaves cancelled bookings out of revenue" expects 11400 (an
  evening price). These show the report and the manager still agree for plain and evening
  bookings.

What the suite would not catch: combinations of rules, such as a long *evening* booking
(e.g. 17:00-20:00, which gets both discounts) or a premium booking longer than 3 hours, on
either path. The report path is never tested with a premium or long booking, so a mistake
that only affected `revenue()` for those cases would pass. As a one-time extra check (not
part of the suite), I compared the old implementations against `priceFor` for every
5-minute-aligned window in a day, across 7 hourly rates and all three `premium` values
(873,936 cases). There were no mismatches.

---

## Milestone 3: Two proposals and one false positive

One proposal for each milestone 1 smell you did not fix.

### Proposal A (not coded)

**The problem.** Phantom complexity in `src/cache/` (Smell 2). `QueryCache` and
`CacheConfig` provide TTL expiry, eviction, an on/off switch, and invalidation, but nothing
ever calls `QueryCache.set()`. The only use, `this.cache.get()` in
`ReservationManager.listBookingsForRoom()`, always misses. The system has the cost of a
cache with none of the benefit.

**The decomposition.** Delete the cache rather than finish it, because nothing in the
current system needs one. Storage is an in-memory `Map`, so there is no slow read to
speed up.
- Remove `src/cache/queryCache.ts` and `src/cache/cacheConfig.ts`.
- Remove from `ReservationManager` the `cache` field, the `new QueryCache(...)` line in the
  constructor, and the two cache imports.
- `listBookingsForRoom()` becomes `return this.storage.findByRoom(roomId);`, which is what
  it already does today in every case.

What remains: `StorageProvider` owns all reads of bookings, and `ReservationManager` just
asks it. If caching is ever needed, e.g. with a slow database, the rule for it should live
next to the data. That would be a `StorageProvider` wrapper that clears its entries inside
`save()` and `update()`, so every write automatically keeps the cache correct. That is a
later design, not part of this change.

**One cost.** Deleting the cache throws away working code and a ready-made extension
point. If a slow storage backend arrives later, someone has to rebuild caching and design
invalidation from scratch. `QueryCache`, `CacheConfig`, `withTtl()`, and `disabled()` are
also exported, so any code outside `src/` that imports them would stop compiling.

### Proposal B (not coded)

**The problem.** Hidden notification dependency in `ReservationManager` (Smell 3). The
constructor always runs `createNotificationChannel(DEFAULT_NOTIFIER_CONFIG)`, which pulls
the email channel out of the global registry in `notifierFactory.ts`. A caller or test
cannot supply a different `NotificationChannel`.

**The decomposition.** Pass the notifier in, the same way storage is already passed in.
- `ReservationManager`'s constructor takes a `notifier: NotificationChannel` parameter
  next to `storage`. `ReservationManager` only *uses* the abstraction: it calls
  `notifier.send()` in `dispatchNotification()` and never decides which channel or
  configuration to use. It no longer imports `notifierFactory` at all.
- Whoever creates the manager *owns* creating and configuring the channel. Application
  startup code would call `createNotificationChannel(config)` (the factory stays as it is)
  and pass the result in. A test would pass a small fake `NotificationChannel` that records
  messages or returns `delivered: false`.
- No new classes are needed. `NotificationChannel` in `src/notifications/channel.ts`
  already is the abstraction.

**One cost.** Every place that constructs a `ReservationManager` now has to build and
pass a notifier: `newService()` in `tests/fixtures.ts`, plus any application code. Because
`storage` is the first parameter, a caller who only wants a custom notifier must also pass
a storage object explicitly. Keeping a default notifier value would avoid breaking
callers, but it would leave the `notifierFactory` import, and the hidden default, inside
`reservationManager.ts`.

### The thing that looks smelly but is fine

**What it is.** The `StorageProvider` interface in `src/storage/storageProvider.ts`
(`save`, `update`, `findById`, `findByRoom`, `findAll`, `clear`). Its only
implementation is `InMemoryStorageProvider` in `src/storage/inMemoryStorageProvider.ts`.
It is used through the `ReservationManager` constructor
(`storage: StorageProvider = new InMemoryStorageProvider()`) and the `ReportGenerator`
constructor (`storage: StorageProvider`, no default).

**Why it is fine.** An interface with one implementation looks like speculative
over-abstraction. But unlike the cache or the notifier registry, this interface is actually
used as a boundary.
- It is the only dependency `ReservationManager` lets a caller pass in, and
  `ReportGenerator` requires it. Every `ReservationManager` read or write (`save`,
  `update`, `findById`, `findByRoom`) goes through it.
- The tests depend on this. `newService()` in `tests/fixtures.ts` creates one store and
  passes it to `ReservationManager`. The four report tests in `tests/reporting.test.ts`
  then pass that *same* object to `ReportGenerator`, so reports see the bookings the
  manager made.
- It hides how bookings are stored. Callers never see the `Map` inside
  `InMemoryStorageProvider`, and the implementation hands out copies, so callers cannot
  change stored bookings by accident.

**What would flip your verdict.** If `ReservationManager` or `ReportGenerator` started
depending on `InMemoryStorageProvider` specifically, the interface would be a false front.
For example, they might need a `Map`-only method, or cast to the concrete class. The
interface would also turn into speculative generality if it kept adding operations no
caller uses. `clear()` is already one: nothing in `src/` or `tests/` calls it.
