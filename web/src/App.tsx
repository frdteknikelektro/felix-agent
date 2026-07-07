import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import { Login } from "@/pages/login";
import { Dashboard } from "@/pages/dashboard";
import { Sessions } from "@/pages/sessions";
import { Thread } from "@/pages/thread";
import { Approvals } from "@/pages/approvals";
import { Skills } from "@/pages/skills";
import { SkillEditor } from "@/pages/skill-editor";
import { Contacts } from "@/pages/contacts";
import { ContactEditor } from "@/pages/contact-editor";
import { Databases } from "@/pages/databases";
import { DatabaseEditor } from "@/pages/database-editor";
import { Audit } from "@/pages/audit";
import { Usage } from "@/pages/usage";
import { NotFound } from "@/pages/not-found";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="sessions/:threadKey" element={<Thread />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="skills" element={<Skills />} />
        <Route path="skills/:skillId" element={<SkillEditor />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="contacts/new" element={<ContactEditor mode="create" />} />
        <Route path="contacts/:source/*" element={<ContactEditor mode="edit" />} />
        <Route path="databases" element={<Databases />} />
        <Route path="databases/new" element={<DatabaseEditor mode="create" />} />
        <Route path="databases/:alias" element={<DatabaseEditor mode="edit" />} />
        <Route path="audit" element={<Audit />} />
        <Route path="usage" element={<Usage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
