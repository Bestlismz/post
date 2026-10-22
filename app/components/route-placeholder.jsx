import { routes } from "../lib/routes.mjs";
import { AppIcon } from "./icons";

const copy = {
  inbox: {
    eyebrow: "Rental operations",
    title: "Inbox",
    body: "ข้อความจาก Facebook Group และ Page จะรวมอยู่ในพื้นที่ทำงานเดียว พร้อมข้อมูลห้องและสถานะการตอบกลับ",
  },
  properties: {
    eyebrow: "Inventory",
    title: "Properties",
    body: "จัดการโครงการ ห้องว่าง ราคา และข้อมูลสำหรับแนะนำลูกค้าจากแหล่งข้อมูลเดียว",
  },
  sources: {
    eyebrow: "Connections",
    title: "Sources",
    body: "ติดตามสถานะ Facebook Page และกลุ่มที่ได้รับอนุญาต รวมถึงงานสแกนและการกู้คืนเซสชัน",
  },
  automations: {
    eyebrow: "Policy control",
    title: "Automations",
    body: "กำหนดโหมดการทำงาน เกณฑ์อนุมัติ รูปแบบข้อความ และขีดจำกัดการตอบกลับอย่างปลอดภัย",
  },
  settings: {
    eyebrow: "Administration",
    title: "Settings",
    body: "จัดการข้อมูลองค์กร ผู้ใช้งาน ความพร้อมของระบบ และประวัติการทำงานจากศูนย์กลาง",
  },
};

export function RoutePlaceholder({ routeId }) {
  const route = routes.find((entry) => entry.id === routeId) ?? routes[0];
  const content = copy[route.id];
  return (
    <section className="rr-empty" aria-labelledby={`${route.id}-title`}>
      <div className="rr-empty__inner">
        <span className="rr-empty__icon" aria-hidden="true">
          <AppIcon name={route.icon} size={22} />
        </span>
        <span className="rr-empty__eyebrow">{content.eyebrow}</span>
        <h1 id={`${route.id}-title`}>{content.title}</h1>
        <p>{content.body}</p>
      </div>
    </section>
  );
}
