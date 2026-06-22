import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <p className="text-4xl font-bold">404</p>
      <p className="text-sm text-muted-foreground">That page doesn't exist.</p>
      <Button variant="secondary" onClick={() => navigate("/")}>
        Back to dashboard
      </Button>
    </div>
  );
}
