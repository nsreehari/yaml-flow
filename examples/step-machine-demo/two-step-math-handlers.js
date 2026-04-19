export default {
  async step1_add(input) {
    const a = Number(input.a);
    const b = Number(input.b);

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return {
        result: 'failure',
        data: { error: 'step1_add requires numeric input a and b' },
      };
    }

    const c = a + b;
    console.log(`[step1_add] a=${a}, b=${b}, c=${c}`);
    return { result: 'success', data: { a, b, c } };
  },

  async step2_double(input) {
    const c = Number(input.c);

    if (!Number.isFinite(c)) {
      return {
        result: 'failure',
        data: { error: 'step2_double requires numeric input c' },
      };
    }

    const d = c * 2;
    console.log(`[step2_double] c=${c}, d=${d}`);
    return { result: 'success', data: { d } };
  },
};
