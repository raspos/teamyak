// ============================================================================
// TEAMYAK Phase 3 — 캘린더 자동 등록 & RFC 5545 (.ics) 생성기
// 요구사항 6 반영:
// - 캘린더 기본 제목은 '팀약 일정'으로 마스킹한다.
// - 상세 정보(모임 제목, 구체적 장소, 호스트명) 포함은 이용자의 선택 사항(includeDetailedInfo)으로 한다.
// - 일정 변경 시 동일 UID + SEQUENCE 증가로 중복 생성 없이 기존 일정을 수정한다.
// ============================================================================

export interface CalendarExportOptions {
  meetingId: string;
  confirmedDate: string;
  startTime: string;
  endTime: string;
  sequenceVersion: number;
  status: string;
  areaHint: string;
  includeDetailedInfo: boolean; // 기본값 false ('팀약 일정'으로만 표시)
  detailedTitle?: string;
  detailedPlace?: string;
  hostLabel?: string;
  morningAlarmTime?: string; // 기본값 "08:00"
}

function formatIcsDateTime(dateStr: string, timeStr: string): string {
  const cleanDate = dateStr.replace(/-/g, "");
  const cleanTime = timeStr.replace(/:/g, "") + "00";
  return `${cleanDate}T${cleanTime}`;
}

export function generateIcsContent(opts: CalendarExportOptions): string {
  const dateStr = opts.confirmedDate || "2026-11-19";
  const startTime = opts.startTime || "12:00";
  const endTime = opts.endTime || "13:30";
  const alarmTime = opts.morningAlarmTime || "08:00";

  const dtStart = formatIcsDateTime(dateStr, startTime);
  const dtEnd = formatIcsDateTime(dateStr, endTime);
  const dtStamp = formatIcsDateTime("2026-11-17", "09:00");
  const alarmDt = formatIcsDateTime(dateStr, alarmTime);

  // 기본 제목은 '팀약 일정'이며, 이용자가 상세 정보 포함을 선택한 경우에만 실제 모임 제목과 상세 장소를 기록
  const summaryText =
    opts.includeDetailedInfo && opts.detailedTitle ? `[팀약] ${opts.detailedTitle}` : "팀약 일정";
  const locationText =
    opts.includeDetailedInfo && opts.detailedPlace ? opts.detailedPlace : `${opts.areaHint} (상세 위치는 팀약 앱에서 확인)`;
  const descText = opts.includeDetailedInfo
    ? `호스트: ${opts.hostLabel || "팀약"}\\n상태: ${opts.status}\\n버전: SEQUENCE v${opts.sequenceVersion}`
    : `개인정보 보호 설정에 따라 상세 모임 정보는 마스킹되었습니다. 팀약 웹앱에서 확인하세요. (SEQUENCE v${opts.sequenceVersion})`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TEAMYAK//Phase3 Hybrid Encrypted Calendar//KO",
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.status === "CANCELED" ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:meeting-${opts.meetingId}@teamyak.kr`,
    `SEQUENCE:${opts.sequenceVersion}`,
    `STATUS:${opts.status === "CANCELED" ? "CANCELLED" : "CONFIRMED"}`,
    `DTSTAMP:${dtStamp}Z`,
    `DTSTART;TZID=Asia/Seoul:${dtStart}`,
    `DTEND;TZID=Asia/Seoul:${dtEnd}`,
    `SUMMARY:${summaryText}`,
    `LOCATION:${locationText}`,
    `DESCRIPTION:${descText}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:[팀약 당일 아침 알림] 오늘 ${startTime} ${summaryText}이 있습니다.`,
    `TRIGGER;VALUE=DATE-TIME:${alarmDt}Z`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.join("\r\n");
}

/**
 * [Apple Calendar / Webcal 전용] 사용자별 다중 일정 ICS 구독 피드 생성기
 * - 참석 수락한 일정들을 모아 하나의 RFC 5545 캘린더 피드로 발행
 * - 동일 UID 유지 및 SEQUENCE 증가 지원
 * - 취소된 모임은 STATUS:CANCELLED 마킹
 */
export function generateIcsFeedContent(
  events: CalendarExportOptions[],
  calendarTitle = "팀약 일정"
): string {
  const dtStamp = formatIcsDateTime("2026-11-17", "09:00");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TEAMYAK//Apple Calendar Feed Engine//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${calendarTitle}`,
    "X-WR-TIMEZONE:Asia/Seoul",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const opts of events) {
    const dateStr = opts.confirmedDate || "2026-11-19";
    const startTime = opts.startTime || "12:00";
    const endTime = opts.endTime || "13:30";
    const alarmTime = opts.morningAlarmTime || "08:00";

    const dtStart = formatIcsDateTime(dateStr, startTime);
    const dtEnd = formatIcsDateTime(dateStr, endTime);
    const alarmDt = formatIcsDateTime(dateStr, alarmTime);

    const summaryText =
      opts.includeDetailedInfo && opts.detailedTitle
        ? `[팀약] ${opts.detailedTitle}`
        : "팀약 일정";
    const locationText =
      opts.includeDetailedInfo && opts.detailedPlace
        ? opts.detailedPlace
        : `${opts.areaHint} (상세 위치는 팀약 앱에서 확인)`;
    const descText = opts.includeDetailedInfo
      ? `호스트: ${opts.hostLabel || "팀약"}\\n상태: ${opts.status}\\n버전: SEQUENCE v${opts.sequenceVersion}`
      : `개인정보 보호 설정에 따라 상세 모임 정보는 마스킹되었습니다. 팀약 웹앱에서 확인하세요. (SEQUENCE v${opts.sequenceVersion})`;

    const isCanceled = opts.status === "CANCELED";

    lines.push(
      "BEGIN:VEVENT",
      `UID:meeting-${opts.meetingId}@teamyak.kr`,
      `SEQUENCE:${opts.sequenceVersion}`,
      `STATUS:${isCanceled ? "CANCELLED" : "CONFIRMED"}`,
      `DTSTAMP:${dtStamp}Z`,
      `DTSTART;TZID=Asia/Seoul:${dtStart}`,
      `DTEND;TZID=Asia/Seoul:${dtEnd}`,
      `SUMMARY:${isCanceled ? `[취소] ${summaryText}` : summaryText}`,
      `LOCATION:${locationText}`,
      `DESCRIPTION:${descText}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:[팀약 당일 아침 알림] 오늘 ${startTime} ${summaryText}이 있습니다.`,
      `TRIGGER;VALUE=DATE-TIME:${alarmDt}Z`,
      "END:VALARM",
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadIcsFile(opts: CalendarExportOptions): void {
  const icsContent = generateIcsContent(opts);
  const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `teamyak-${opts.meetingId}-seq-v${opts.sequenceVersion}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildGoogleCalendarUrl(opts: CalendarExportOptions): string {
  const dateStr = (opts.confirmedDate || "2026-11-19").replace(/-/g, "");
  const start = (opts.startTime || "12:00").replace(":", "") + "00";
  const end = (opts.endTime || "13:30").replace(":", "") + "00";

  const summaryText =
    opts.includeDetailedInfo && opts.detailedTitle ? `[팀약] ${opts.detailedTitle}` : "팀약 일정";
  const locationText =
    opts.includeDetailedInfo && opts.detailedPlace ? opts.detailedPlace : opts.areaHint;
  const detailsText = opts.includeDetailedInfo
    ? `호스트: ${opts.hostLabel || ""}\n팀약 동기화 ID: meeting-${opts.meetingId}@teamyak.kr (v${opts.sequenceVersion})`
    : `상세 미팅 정보는 개인정보 보호를 위해 생략되었습니다. (ID: meeting-${opts.meetingId}@teamyak.kr / v${opts.sequenceVersion})`;

  const query = new URLSearchParams({
    action: "TEMPLATE",
    text: summaryText,
    dates: `${dateStr}T${start}/${dateStr}T${end}`,
    details: detailsText,
    location: locationText,
    ctz: "Asia/Seoul",
  });

  return `https://calendar.google.com/calendar/render?${query.toString()}`;
}
