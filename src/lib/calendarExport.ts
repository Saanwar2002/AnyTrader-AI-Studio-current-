// AT-CJ-SCHED-02: Real Europe/London Appointment Calendar Export Helpers
// Encodes real appointment date and time slots in Europe/London (GMT/BST)
// instead of fixed UTC placeholder hours.

export const LONDON_TIMEZONE = "Europe/London";

export interface LondonAppointmentWindow {
  dateYmd: string; // YYYY-MM-DD
  startTimeHm: string; // HH:mm
  endTimeHm: string; // HH:mm
  startLocalCompact: string; // YYYYMMDDTHHMMSS
  endLocalCompact: string; // YYYYMMDDTHHMMSS
  startIsoWithLondonOffset: string; // YYYY-MM-DDTHH:mm:00+00:00 or +01:00
  endIsoWithLondonOffset: string; // YYYY-MM-DDTHH:mm:00+00:00 or +01:00
  timezone: "Europe/London";
}

function pad2(n: number): string {
  return String(Math.floor(Math.max(0, n))).padStart(2, "0");
}

function normalizeYmd(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const ymdMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymdMatch) {
      return `${ymdMatch[1]}-${ymdMatch[2]}-${ymdMatch[3]}`;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDateInLondonYmd(parsed);
    }
    return null;
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return formatDateInLondonYmd(raw);
  }
  if (typeof raw === "object" && raw !== null) {
    const anyRaw = raw as any;
    if (typeof anyRaw.toDate === "function") {
      const d = anyRaw.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        return formatDateInLondonYmd(d);
      }
    }
    if (typeof anyRaw.seconds === "number") {
      return formatDateInLondonYmd(new Date(anyRaw.seconds * 1000));
    }
  }
  return null;
}

export function formatDateInLondonYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value || "2026";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";
  return `${year}-${month}-${day}`;
}

function parseTimeHm(raw: unknown): { hours: number; minutes: number } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  // Match "14:30", "9:00", "09:15:00", "2:30 pm", "9am"
  const m = trimmed.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]?.toLowerCase();

  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function parseTimeSlotRange(
  raw: unknown
): { start: { hours: number; minutes: number }; end?: { hours: number; minutes: number } } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Handle "10:00 - 13:30" or "09:30-11:30" or "2pm - 4pm"
  const rangeParts = trimmed.split(/\s*(?:-|to|–)\s*/i);
  if (rangeParts.length === 2) {
    const start = parseTimeHm(rangeParts[0]);
    const end = parseTimeHm(rangeParts[1]);
    if (start && end) return { start, end };
  }

  // Handle ISO timestamp like "2026-07-15T10:30:00"
  const isoTime = trimmed.match(/T(\d{2}):(\d{2})/);
  if (isoTime) {
    return {
      start: { hours: parseInt(isoTime[1], 10), minutes: parseInt(isoTime[2], 10) },
    };
  }

  const single = parseTimeHm(trimmed);
  if (single) return { start: single };

  // Named slot fallbacks
  const lower = trimmed.toLowerCase();
  if (lower.includes("morning")) return { start: { hours: 9, minutes: 0 }, end: { hours: 12, minutes: 0 } };
  if (lower.includes("afternoon")) return { start: { hours: 13, minutes: 0 }, end: { hours: 17, minutes: 0 } };
  if (lower.includes("evening")) return { start: { hours: 17, minutes: 30 }, end: { hours: 20, minutes: 0 } };

  return null;
}

function parseDurationMinutes(job: any, quote: any): number {
  const candidates = [
    quote?.durationMinutes,
    job?.durationMinutes,
    typeof quote?.durationHours === "number" ? quote.durationHours * 60 : null,
    typeof job?.durationHours === "number" ? job.durationHours * 60 : null,
  ];
  for (const val of candidates) {
    if (typeof val === "number" && Number.isFinite(val) && val >= 15 && val <= 12 * 60) {
      return Math.round(val);
    }
  }

  const timelineStr = String(quote?.estimatedTimeline || job?.estimatedCompletionTime || "").toLowerCase();
  const hrMatch = timelineStr.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour)/);
  if (hrMatch) {
    const mins = Math.round(parseFloat(hrMatch[1]) * 60);
    if (mins >= 30 && mins <= 10 * 60) return mins;
  }

  return 120; // Default 2-hour appointment window when end time not specified
}

/**
 * Computes Europe/London UTC offset string (+00:00 for GMT, +01:00 for BST)
 * for a given local YYYY-MM-DD and HH:mm.
 */
export function getLondonOffsetForLocalDateTime(dateYmd: string, timeHm: string): "+00:00" | "+01:00" {
  const [y, m, d] = dateYmd.split("-").map((v) => parseInt(v, 10));
  const [hh, mm] = timeHm.split(":").map((v) => parseInt(v, 10));
  const probeUtc = new Date(Date.UTC(y, (m || 1) - 1, d || 1, hh || 12, mm || 0, 0));

  const tzPart = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIMEZONE,
    timeZoneName: "shortOffset",
  })
    .formatToParts(probeUtc)
    .find((p) => p.type === "timeZoneName")?.value;

  if (tzPart && (tzPart.includes("+1") || tzPart.includes("+01"))) {
    return "+01:00";
  }
  return "+00:00";
}

function addMinutesClamped(
  dateYmd: string,
  hours: number,
  minutes: number,
  addMins: number
): { dateYmd: string; hours: number; minutes: number } {
  const total = hours * 60 + minutes + addMins;
  const dayOverflow = Math.floor(total / (24 * 60));
  const rem = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const nextHours = Math.floor(rem / 60);
  const nextMinutes = rem % 60;

  if (dayOverflow === 0) {
    return { dateYmd, hours: nextHours, minutes: nextMinutes };
  }

  const [y, m, d] = dateYmd.split("-").map((v) => parseInt(v, 10));
  const nextDate = new Date(Date.UTC(y, m - 1, d + dayOverflow, 12, 0, 0));
  return {
    dateYmd: formatDateInLondonYmd(nextDate),
    hours: nextHours,
    minutes: nextMinutes,
  };
}

/**
 * Resolves the real scheduled appointment window in Europe/London timezone
 * from job & quote scheduling fields.
 */
export function resolveLondonAppointmentWindow(job: any, quote: any): LondonAppointmentWindow {
  const dateYmd =
    normalizeYmd(job?.scheduledDate) ||
    normalizeYmd(job?.appointmentDate) ||
    normalizeYmd(quote?.startDate) ||
    normalizeYmd(job?.jobDate) ||
    normalizeYmd(job?.preferredDate) ||
    formatDateInLondonYmd(new Date());

  const explicitRange =
    parseTimeSlotRange(job?.appointmentTimeSlot) ||
    parseTimeSlotRange(job?.scheduledTimeSlot) ||
    parseTimeSlotRange(job?.timeSlot) ||
    parseTimeSlotRange(quote?.timeSlot);

  const explicitStart =
    explicitRange?.start ||
    parseTimeHm(job?.scheduledTime) ||
    parseTimeHm(job?.startTime) ||
    parseTimeHm(quote?.startTime) ||
    parseTimeSlotRange(job?.scheduledDate)?.start ||
    parseTimeSlotRange(quote?.startDate)?.start ||
    { hours: 9, minutes: 0 };

  const explicitEnd =
    explicitRange?.end ||
    parseTimeHm(job?.endTime) ||
    parseTimeHm(quote?.endTime);

  const durationMins = parseDurationMinutes(job, quote);
  let endDateYmd = dateYmd;
  let endHours: number;
  let endMinutes: number;

  if (
    explicitEnd &&
    explicitEnd.hours * 60 + explicitEnd.minutes > explicitStart.hours * 60 + explicitStart.minutes
  ) {
    endHours = explicitEnd.hours;
    endMinutes = explicitEnd.minutes;
  } else {
    const computedEnd = addMinutesClamped(dateYmd, explicitStart.hours, explicitStart.minutes, durationMins);
    endDateYmd = computedEnd.dateYmd;
    endHours = computedEnd.hours;
    endMinutes = computedEnd.minutes;
  }

  const startTimeHm = `${pad2(explicitStart.hours)}:${pad2(explicitStart.minutes)}`;
  const endTimeHm = `${pad2(endHours)}:${pad2(endMinutes)}`;
  const compactStartDate = dateYmd.replace(/-/g, "");
  const compactEndDate = endDateYmd.replace(/-/g, "");
  const startLocalCompact = `${compactStartDate}T${pad2(explicitStart.hours)}${pad2(explicitStart.minutes)}00`;
  const endLocalCompact = `${compactEndDate}T${pad2(endHours)}${pad2(endMinutes)}00`;

  const startOffset = getLondonOffsetForLocalDateTime(dateYmd, startTimeHm);
  const endOffset = getLondonOffsetForLocalDateTime(endDateYmd, endTimeHm);

  return {
    dateYmd,
    startTimeHm,
    endTimeHm,
    startLocalCompact,
    endLocalCompact,
    startIsoWithLondonOffset: `${dateYmd}T${startTimeHm}:00${startOffset}`,
    endIsoWithLondonOffset: `${endDateYmd}T${endTimeHm}:00${endOffset}`,
    timezone: LONDON_TIMEZONE,
  };
}

function escapeIcsText(text: string): string {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Generates an RFC 5545 compliant .ics calendar export with an explicit
 * VTIMEZONE block for Europe/London (GMT/BST) and TZID-bound DTSTART/DTEND.
 */
export function buildLondonIcsContent(job: any, quote: any): string {
  const win = resolveLondonAppointmentWindow(job, quote);
  const uid = `anytrader-job-${job?.id || "appointment"}@anytrader.co.uk`;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const summary = escapeIcsText(`Job: ${job?.title || "Trade Appointment"}`);
  const description = escapeIcsText(
    `Job Details: ${job?.description || "Scheduled service"}\n\nQuote Amount: £${quote?.amount ?? ""}\nJob ID: ${job?.id || ""}`
  );
  const location = escapeIcsText(job?.postcode || job?.location || "");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AnyTrader//UK Trade Scheduling//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/London",
    "X-LIC-LOCATION:Europe/London",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0100",
    "TZNAME:BST",
    "DTSTART:19700329T010000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0000",
    "TZNAME:GMT",
    "DTSTART:19701025T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=Europe/London:${win.startLocalCompact}`,
    `DTEND;TZID=Europe/London:${win.endLocalCompact}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function buildGoogleCalendarUrl(job: any, quote: any): string {
  const win = resolveLondonAppointmentWindow(job, quote);
  const title = encodeURIComponent(`Job: ${job?.title || "Trade Appointment"}`);
  const description = encodeURIComponent(
    `Job Details: ${job?.description || ""}\n\nQuote Amount: £${quote?.amount ?? ""}\nJob ID: ${job?.id || ""}`
  );
  const location = encodeURIComponent(job?.postcode || job?.location || "");
  return `https://www.google.com/calendar/render?action=TEMPLATE&text=${title}&details=${description}&location=${location}&dates=${win.startLocalCompact}/${win.endLocalCompact}&ctz=${encodeURIComponent(LONDON_TIMEZONE)}`;
}

export function buildOutlookCalendarUrl(job: any, quote: any): string {
  const win = resolveLondonAppointmentWindow(job, quote);
  const title = encodeURIComponent(`Job: ${job?.title || "Trade Appointment"}`);
  const description = encodeURIComponent(
    `Job Details: ${job?.description || ""}\n\nQuote Amount: £${quote?.amount ?? ""}\nJob ID: ${job?.id || ""}`
  );
  const location = encodeURIComponent(job?.postcode || job?.location || "");
  return `https://outlook.live.com/calendar/0/deeplink/compose?subject=${title}&body=${description}&location=${location}&startdt=${encodeURIComponent(win.startIsoWithLondonOffset)}&enddt=${encodeURIComponent(win.endIsoWithLondonOffset)}`;
}
