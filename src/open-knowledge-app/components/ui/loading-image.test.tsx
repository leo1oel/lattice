import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingImage } from './loading-image';

describe('LoadingImage', () => {
  it('distinguishes a proven-missing target from a decode failure and heals', async () => {
    const view = render(
      <LoadingImage src="figures/plot.png" alt="Plot" targetExistence="missing" />,
    );

    expect(screen.getByTestId('image-slot')).toHaveAttribute('data-image-error-kind', 'not-found');
    expect(screen.getByRole('img', { name: 'Image not found: Plot' })).toBeInTheDocument();
    expect(screen.getByAltText('Plot')).toHaveAttribute('hidden');

    view.rerender(
      <LoadingImage src="figures/plot.png" alt="Plot" targetExistence="exists" />,
    );

    await waitFor(() => expect(screen.getByTestId('image-slot')).not.toHaveAttribute(
      'data-image-error-kind',
    ));
    expect(screen.getByAltText('Plot')).not.toHaveAttribute('hidden');
  });
});
