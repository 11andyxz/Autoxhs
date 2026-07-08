/**
 * 求职身份档案的「纯元数据」——字段定义 + 空值构造。
 * 不含任何 DB / 服务端依赖,可被客户端组件安全导入(表单渲染用)。
 * 服务端读写见 lib/indeed/profile.ts。
 */

export type ApplicantProfile = {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  workAuthorization: string;
  requiresSponsorship: string;
  citizenship: string;
  yearsExperience: string;
  willingToRelocate: string;
  workPreference: string;
  securityClearance: string;
  veteranStatus: string;
  disabilityStatus: string;
  gender: string;
  raceEthnicity: string;
  notes: string;
};

/** 字段顺序 + 中文标签(表单渲染 + 拼给 AI 的事实清单共用)。 */
export const PROFILE_FIELDS: Array<{ key: keyof ApplicantProfile; label: string; long?: boolean }> = [
  { key: "fullName", label: "姓名" },
  { key: "email", label: "邮箱" },
  { key: "phone", label: "电话" },
  { key: "location", label: "所在地(城市, 州)" },
  { key: "workAuthorization", label: "工作授权(如 US Citizen / Green Card / H1B / F1 OPT-EAD)" },
  { key: "requiresSponsorship", label: "现在或将来是否需要 sponsorship(Yes/No)" },
  { key: "citizenship", label: "公民 / 居留身份" },
  { key: "yearsExperience", label: "总工作年限" },
  { key: "willingToRelocate", label: "是否愿意 relocate(Yes/No)" },
  { key: "workPreference", label: "工作方式偏好(Onsite/Remote/Hybrid)" },
  { key: "securityClearance", label: "安全许可(如有)" },
  { key: "veteranStatus", label: "退伍军人身份(EEO,可留空)" },
  { key: "disabilityStatus", label: "残障状况(EEO,可留空)" },
  { key: "gender", label: "性别(EEO,可留空)" },
  { key: "raceEthnicity", label: "族裔(EEO,可留空)" },
  { key: "notes", label: "其他补充事实(自由填写,AI 也会参考)", long: true },
];

export function emptyProfile(): ApplicantProfile {
  return PROFILE_FIELDS.reduce((acc, f) => {
    acc[f.key] = "";
    return acc;
  }, {} as ApplicantProfile);
}
