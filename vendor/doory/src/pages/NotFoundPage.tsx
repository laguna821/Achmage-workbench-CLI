import { Compass } from 'lucide-react'
import { EmptyState, LinkButton } from '@/ui'
import { usePageMeta } from '@/lib/usePageMeta'

export default function NotFoundPage() {
  usePageMeta({ title: 'Page not found', noindex: true })
  return (
    <div style={{ display: 'grid', minHeight: '70dvh', placeItems: 'center' }}>
      <EmptyState
        icon={<Compass size={28} />}
        title="We can’t find that page"
        description="The link may be broken, or the page may have moved."
        action={
          <>
            <LinkButton to="/">Go home</LinkButton>
            <LinkButton to="/create" variant="secondary">
              Start designing
            </LinkButton>
          </>
        }
      />
    </div>
  )
}
