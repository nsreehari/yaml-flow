export default {
  async step1_add(input) {
    const a = Number(input.a);
    const b = Number(input.b);

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return {
        result: 'failure',
        data: { error: 'step1_add expects numeric a and b' },
      };
    }

    const c = a + b;

    return {
      result: 'success',
      data: {
        a,
        b,
        c,
      },
    };
  },
};
