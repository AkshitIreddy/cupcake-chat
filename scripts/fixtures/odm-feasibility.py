"""ODM feasibility: transparent load/energy estimates and an ideal cable phase.

Assumed 80 kg person plus equipment; speeds/radii are scenarios, not anime
measurements. A massless fixed-length cable holds a point mass until tension
would become negative, then it follows a ballistic path. No reel, drag, body
rotation, anchor failure, or propulsion is modeled. This is not a wearable design.
"""
import csv
import math
import unittest

G = 9.81


def turning_case(speed, radius, mass=80.0):
    if radius <= 0 or mass <= 0 or speed < 0:
        raise ValueError("Positive radius/mass and nonnegative speed required")
    radial = speed * speed / radius
    return {"speed_m_s": speed, "radius_m": radius,
            "radial_accel_m_s2": radial, "radial_g": radial / G,
            "bottom_cable_n": mass * (radial + G),
            "bottom_load_weight_ratio": 1 + radial / G}


def launch_energy(mass=80.0, speed=20.0, height=10.0, seconds=2.0):
    if mass <= 0 or speed < 0 or height < 0 or seconds <= 0:
        raise ValueError("Use positive mass/time and nonnegative speed/height")
    kinetic = 0.5 * mass * speed * speed
    potential = mass * G * height
    return kinetic, potential, (kinetic + potential) / seconds


def step(theta, omega, radius, dt):
    def derivative(t, w):
        return w, -G / radius * math.sin(t)

    a = derivative(theta, omega)
    b = derivative(theta + dt * a[0] / 2, omega + dt * a[1] / 2)
    c = derivative(theta + dt * b[0] / 2, omega + dt * b[1] / 2)
    d = derivative(theta + dt * c[0], omega + dt * c[1])
    return (theta + dt * (a[0] + 2*b[0] + 2*c[0] + d[0]) / 6,
            omega + dt * (a[1] + 2*b[1] + 2*c[1] + d[1]) / 6)


def cable_phase(speed=20.0, radius=10.0, mass=80.0, dt=0.002, duration=6.0):
    turning_case(speed, radius, mass)
    if dt <= 0 or duration <= 0:
        raise ValueError("Positive time steps required")
    theta, omega, elapsed = 0.0, speed / radius, 0.0
    released = False
    x, y, vx, vy = 0.0, -radius, speed, 0.0
    samples = []
    while elapsed <= duration + dt / 2:
        if not released:
            tension = mass * (radius * omega * omega + G * math.cos(theta))
            x, y = radius * math.sin(theta), -radius * math.cos(theta)
            vx, vy = radius * omega * math.cos(theta), radius * omega * math.sin(theta)
            if tension < 0:
                released = True
                tension = 0.0
        else:
            tension = 0.0
        energy = 0.5 * mass * (vx*vx + vy*vy) + mass * G * (y + radius)
        samples.append({"time_s": elapsed, "x_m": x, "y_m": y,
                        "vx_m_s": vx, "vy_m_s": vy,
                        "tension_n": tension, "energy_j": energy,
                        "released": released})
        if released:
            x += vx * dt
            y += vy * dt - 0.5 * G * dt * dt
            vy -= G * dt
        else:
            theta, omega = step(theta, omega, radius, dt)
        elapsed += dt
    return samples


class PhysicsChecks(unittest.TestCase):
    def test_known_turn_load(self):
        case = turning_case(20, 10)
        self.assertAlmostEqual(case["radial_accel_m_s2"], 40)
        self.assertAlmostEqual(case["bottom_cable_n"], 3984.8)

    def test_speed_squared_scaling(self):
        self.assertAlmostEqual(turning_case(40, 10)["radial_g"],
                               4 * turning_case(20, 10)["radial_g"])

    def test_energy_and_power_are_distinct(self):
        kinetic, potential, power = launch_energy()
        self.assertEqual(kinetic, 16000)
        self.assertAlmostEqual(potential, 7848)
        self.assertAlmostEqual(power, 11924)

    def test_numerical_energy_conservation(self):
        samples = cable_phase()
        self.assertLess(max(abs(s["energy_j"] - 16000) for s in samples), 0.01)

    def test_initial_state_and_length(self):
        samples = cable_phase()
        self.assertEqual(samples[0]["x_m"], 0)
        self.assertEqual(samples[0]["y_m"], -10)
        self.assertEqual(samples[0]["vx_m_s"], 20)
        for sample in samples:
            if not sample["released"]:
                self.assertAlmostEqual(math.hypot(sample["x_m"], sample["y_m"]), 10)

    def test_cable_releases_instead_of_pushing(self):
        samples = cable_phase()
        self.assertTrue(any(s["released"] for s in samples))
        self.assertGreaterEqual(min(s["tension_n"] for s in samples), 0)
        # Analytic energy+tension condition: cos(theta) = (2gr-v0^2)/(3gr).
        first = next(s for s in samples if s["released"])
        expected_cos = (2 * G * 10 - 20**2) / (3 * G * 10)
        self.assertAlmostEqual(-first["y_m"] / 10, expected_cos, delta=0.003)

    def test_ballistic_phase(self):
        released = [s for s in cable_phase() if s["released"]]
        first, last = released[0], released[-1]
        time = last["time_s"] - first["time_s"]
        self.assertAlmostEqual(last["x_m"], first["x_m"] + first["vx_m_s"] * time, places=7)
        self.assertAlmostEqual(last["vy_m_s"], first["vy_m_s"] - G * time, places=7)


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(PhysicsChecks))
    if not result.wasSuccessful():
        raise SystemExit(1)
    cases = [turning_case(speed, radius) for speed in (10, 20, 30) for radius in (5, 10, 20)]
    with open("odm-turning-loads.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=cases[0].keys())
        writer.writeheader()
        writer.writerows(cases)
    samples = cable_phase()
    with open("odm-cable-phase.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=samples[0].keys())
        writer.writeheader()
        writer.writerows(samples)
    print("80 kg, 20 m/s, 10 m radius: bottom tension = 3984.8 N; load = 5.08 times weight.")
    print("Ideal 20 m/s + 10 m climb: 23848 J, or 11924 W average over two seconds.")
    print("Fixed-anchor cable phase releases when tension reaches zero; no negative cable force.")
    print("Limits: no reel, drag, body rotation, propulsion, anchor failure, or human tolerance validation.")
