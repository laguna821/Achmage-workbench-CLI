import { Hero } from '@/features/landing/Hero'
import { LocalDesignsStrip } from '@/features/landing/LocalDesignsStrip'
import { usePageMeta } from '@/lib/usePageMeta'

const DESCRIPTION = 'Doory is a free, open-source design platform. Make social posts, slides, posters and logos in your browser. No account needed to start.'

export default function LandingPage() {
  usePageMeta({ description: DESCRIPTION, canonical: '/', image: '/og-image.png' })
  return (
    <>
      <Hero />
      <LocalDesignsStrip />
    </>
  )
}
