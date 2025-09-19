import { Link } from "react-router";

export default function NotFoundPage() {
  return (
    <>
      <div>Page not found</div>
      <div>
        <Link to="/">Go home</Link>
      </div>
    </>
  );
}
