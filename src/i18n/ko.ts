export const ko = {
  app: {
    name: "팀약",
    engName: "TEAMYAK",
    slogan: "약속은 쉽게, 일정은 자동으로, 만남은 기록으로.",
    principle: "약속은 연결하지만, 관계는 소유하지 않는다.",
    securityBadge: "종단간 개인메모 암호화 · 양측 독립 공유 통제",
  },
  nav: {
    home: "홈",
    calendar: "캘린더",
    meetings: "모임",
    history: "이력",
    my: "마이",
    newMeeting: "새 모임 만들기",
  },
  onboarding: {
    welcomeTitle: "업무 약속의 새로운 기준, 팀약",
    welcomeSubtitle:
      "카카오톡으로 초대하고 수락하면 캘린더 정리부터 기관별 만남 기록까지 자동으로 완성됩니다.",
    optionCreateTeam: "① 팀 만들기",
    optionCreateTeamDesc: "기업 홍보팀·언론사 데스크 등 우리 팀 공간을 만들고 첫 약속을 잡으세요.",
    optionCheckInvite: "② 초대받은 약속 확인하기",
    optionCheckInviteDesc: "팀에 가입하지 않아도 카카오톡으로 받은 초대 링크로 즉시 참석을 응답할 수 있습니다.",
    kakaoLoginBtn: "카카오로 3초 만에 시작하기",
    privacyNotice:
      "팀약은 휴대전화 주소록이나 문자 내역을 수집하지 않으며, 운영자도 회원님의 미팅 관계를 열람할 수 없습니다.",
  },
  meetingStatus: {
    SCHEDULING: "일정 조율 중",
    RECRUITING: "참석자 모집 중",
    CONFIRMED: "일정 확정",
    COMPLETED: "모임 완료",
    CANCELED: "취소됨",
  },
  rsvp: {
    ATTENDING: "참석",
    TENTATIVE: "보류",
    DECLINED: "불참",
    PENDING_APPROVAL: "호스트 승인 대기",
  },
  attendance: {
    UNCONFIRMED: "참석 수락(미확인)",
    VERIFIED_ATTENDED: "실제 만남 확인됨",
    NO_SHOW: "불참/취소",
  },
  visibility: {
    PRIVATE_PARTICIPANTS_ONLY: "비공개 (참석자만 열람)",
    TEAM_SHARED: "우리 팀에 일정 공유",
    independentNotice:
      "호스트와 게스트는 각자 소속 팀 공유 여부를 독립적으로 결정합니다. 한쪽이 공유해도 상대 팀에는 절대 자동 공개되지 않습니다.",
  },
  tabs: {
    ourCompanyNews: "① 우리 회사 뉴스",
    counterpartNews: "② 만나는 회사 뉴스",
  },
} as const;

export type LocaleDict = typeof ko;
