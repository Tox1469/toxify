//! Velocidade e tom independentes (Signalsmith Stretch, MIT, compilado em build.rs).
//! Ponte escrita à mão pras 5 funções que o motor usa.

#[repr(C)]
struct Raw {
    _p: [u8; 0],
}

unsafe extern "C" {
    fn signalsmith_stretch_create_preset_default(channel_count: i32, sample_rate: f32) -> *mut Raw;
    fn signalsmith_stretch_destroy(h: *mut Raw);
    fn signalsmith_stretch_reset(h: *mut Raw);
    fn signalsmith_stretch_set_transpose_factor(h: *mut Raw, multiplier: f32, tonality_limit: f32);
    fn signalsmith_stretch_process(h: *mut Raw, input: *mut f32, input_length: usize, output: *mut f32, output_length: usize);
}

pub struct Stretch {
    h: *mut Raw,
    channels: usize,
    pub rate: u32,
}

// Só a thread do motor usa.
unsafe impl Send for Stretch {}

impl Stretch {
    pub fn new(channels: usize, rate: u32) -> Stretch {
        let h = unsafe { signalsmith_stretch_create_preset_default(channels as i32, rate as f32) };
        assert!(!h.is_null(), "signalsmith não abriu");
        Stretch { h, channels, rate }
    }

    pub fn reset(&mut self) {
        unsafe { signalsmith_stretch_reset(self.h) }
    }

    /// Tom: 1.0 = original, 2.0 = uma oitava acima.
    pub fn set_pitch(&mut self, ratio: f32) {
        unsafe { signalsmith_stretch_set_transpose_factor(self.h, ratio, 0.0) }
    }

    /// Entrada e saída intercaladas. A razão entre os tamanhos é a velocidade
    /// (entrada com o dobro de frames = toca 2x mais rápido, sem mudar o tom).
    pub fn process(&mut self, input: &[f32], output: &mut [f32]) {
        let (inf, outf) = (input.len() / self.channels, output.len() / self.channels);
        unsafe { signalsmith_stretch_process(self.h, input.as_ptr() as *mut f32, inf, output.as_mut_ptr(), outf) }
    }
}

impl Drop for Stretch {
    fn drop(&mut self) {
        unsafe { signalsmith_stretch_destroy(self.h) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lá (440 Hz) tocado 2x mais rápido continua 440 Hz; com tom 2.0 vira 880 Hz.
    #[test]
    fn velocidade_e_tom() {
        let rate = 48000u32;
        let sine: Vec<f32> = (0..rate as usize * 4).flat_map(|i| {
            let x = (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5;
            [x, x]
        }).collect();
        let freq = |buf: &[f32]| {
            // conta subidas pelo zero no canal esquerdo, pulando o começo (latência)
            let l: Vec<f32> = buf.chunks_exact(2).map(|f| f[0]).skip(rate as usize / 2).collect();
            let ups = l.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
            ups as f32 / (l.len() as f32 / rate as f32)
        };
        let mut st = Stretch::new(2, rate);
        let mut out = vec![0f32; rate as usize * 2 * 2]; // 2 s de saída pra 4 s de entrada = 2x
        st.process(&sine, &mut out);
        let f = freq(&out);
        assert!((f - 440.0).abs() < 15.0, "2x mais rápido mudou o tom: {f} Hz");
        let mut st = Stretch::new(2, rate);
        st.set_pitch(2.0);
        let mut out = vec![0f32; rate as usize * 4 * 2];
        st.process(&sine, &mut out);
        let f = freq(&out);
        assert!((f - 880.0).abs() < 25.0, "tom 2.0 não foi pra 880 Hz: {f} Hz");
        eprintln!("ok: velocidade mantém o tom, tom 2.0 = {f:.0} Hz");
    }
}
