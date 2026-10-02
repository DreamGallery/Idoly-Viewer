import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function ListPagination({ page, pages, label, onChange }: {
  page: number;
  pages: number;
  label: string;
  onChange: (page: number) => void;
}) {
  if (pages <= 1) return null;
  return <nav className="list-pagination" aria-label={label}>
    <button type="button" aria-label="上一页" disabled={page === 1} onClick={() => onChange(page - 1)}><ChevronLeft size={18}/></button>
    <span role="status" aria-live="polite" aria-atomic="true">第 {page} / {pages} 页</span>
    <button type="button" aria-label="下一页" disabled={page === pages} onClick={() => onChange(page + 1)}><ChevronRight size={18}/></button>
  </nav>;
}
