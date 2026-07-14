export const MIP_NPM = 'https://www.npmjs.com/package/@effectstream/mip-zswap-offer'

export function MipNpmLink({ note }: { note: string }) {
  return (
    <p className="mip-ref">
      {note}{' '}
      <a href={MIP_NPM} target="_blank" rel="noreferrer">@effectstream/mip-zswap-offer</a>
    </p>
  )
}
